import { randomUUID } from "node:crypto";
import { createPool, runMigrations } from "../src/db/pool.js";
import { StandardRailJournal } from "../src/standardRail/journal.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { StandardProviderDispatch } from "../src/standardRail/providerDispatch.js";
import type { EvidenceResult, ReleaseEvidenceResult } from "../src/standardRail/evidence.js";
import type {
  SignedEnvelope,
  StandardListing,
  StandardOrderRecord,
  StandardRailDispatchV2,
} from "../src/standardRail/types.js";
import {
  parseStandardRailDispatchV2,
  STANDARD_DISPATCH_V2_KEYS,
} from "../src/standardRail/wireContracts.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const address = (byte: string): Hex => `0x${byte.repeat(40)}` as Hex;
const privateKey = `0x${"11".repeat(32)}` as Hex;

function evidence(): { deposit: EvidenceResult; release: ReleaseEvidenceResult } {
  const deposit: EvidenceResult = {
    transactionHash: hash("a"),
    blockNumber: 101n,
    blockHash: hash("b"),
    transactionIndex: 2,
    logIndex: 3,
    evidenceHash: hash("c"),
    canonicalEvidence: { kind: "deposit" },
    sources: ["rpc-a", "rpc-b"],
  };
  return {
    deposit,
    release: {
      transactionHash: hash("d"),
      blockNumber: 102n,
      blockHash: hash("e"),
      transactionIndex: 4,
      logIndex: 5,
      evidenceHash: hash("f"),
      canonicalEvidence: { kind: "release" },
      sources: ["rpc-a", "rpc-b"],
      providerNetAmount: 90n,
      daskiCommissionAmount: 10n,
      releaseSequence: 8n,
    },
  };
}

function listing(): StandardListing {
  return {
    commitment: { payload: {
      providerControlProfileHash: hash("1"),
      serviceId: hash("2"),
      bindingProfile: "stock-fixed-v1",
      providerAuthorityKey: address("2"),
      providerTerminalAttestationKey: address("2"),
      providerPayee: address("3"),
      daskiCommissionReceiver: address("4"),
      providerAgentId: "7",
    } },
    manifest: { payload: { splitterAddress: address("5") } },
    runtimeCommitmentHash: hash("4"),
    providerIntentHash: hash("5"),
    providerOwner: address("2"),
    providerAgentWallet: address("2"),
    screeningPolicy: { providerControlledWallets: [] },
    providerControlProfile: { payload: {
      providerAudience: "provider.example",
      dispatchUrl: "https://provider.example/dispatch",
      timeoutMs: 1_000,
      maxResponseBytes: 16384,
      dispatchStatusUrl: "https://provider.example/dispatch/status",
    } },
    deadlinePolicy: { dispatchSeconds: 300, fulfillmentSeconds: 3600 },
  } as unknown as StandardListing;
}

function order(): StandardOrderRecord {
  return {
    orderId: "order-1",
    orderKey: hash("3"),
    state: "RELEASE_FINAL",
    payer: address("1"),
    listingManifestHash: hash("4"),
    providerOfferHash: hash("5"),
    quoteHash: hash("6"),
    canonicalRequestHash: hash("7"),
    orderNonce: hash("8"),
    settlementTxHash: hash("a"),
    depositEvidenceHash: hash("c"),
    releaseTxHash: hash("d"),
    releaseEvidenceHash: hash("f"),
    grossAmount: "100",
    providerNetAmount: "90",
    daskiCommissionAmount: "10",
    quote: { artifactType: "QuoteV1" },
  } as unknown as StandardOrderRecord;
}

interface DispatchInvoker {
  dispatch(
    order: StandardOrderRecord,
    listing: StandardListing,
    request: unknown,
    confirmationHash: Hex,
    bundle: { deposit: EvidenceResult; release: ReleaseEvidenceResult },
  ): Promise<StandardOrderRecord>;
}

function service(args: {
  persisted?: { dispatch: SignedEnvelope<StandardRailDispatchV2, 2>; request: unknown };
  capture?: (dispatch: SignedEnvelope<StandardRailDispatchV2, 2>, body: string) => void;
} = {}): DispatchInvoker {
  let claimed: SignedEnvelope<StandardRailDispatchV2, 2> | null = null;
  const config = {
    environment: "testnet",
    gatewayAudience: "gateway.example",
    reputationContract: address("6"),
    reputationOutcomeSchemaUid: hash("9"),
    dispatchPrivateKey: privateKey,
    quotePrivateKey: privateKey,
    receiptPrivateKey: privateKey,
    lifecyclePrivateKey: privateKey,
    releasePrivateKey: privateKey,
    reputationOrderPrivateKey: privateKey,
    reputationRelayerPrivateKey: privateKey,
    dispatchTimeoutMs: 1_000,
    manifest: { providerIdentitySnapshots: [] },
  };
  return new StandardProviderDispatch(
    { chainId: 84532 } as never,
    config as never,
    {
      dispatchRecovery: async () => ({ started_at: new Date(), retry_pending: false, next_attempt_at: new Date() }),
      dispatchClaim: async () => args.persisted ?? null,
      claimDispatch: async (
        claim: { dispatch: SignedEnvelope<StandardRailDispatchV2, 2> },
      ) => {
        claimed = claim.dispatch;
        return true;
      },
    } as never,
    {
      transition: async (
        value: StandardOrderRecord,
        state: StandardOrderRecord["state"],
      ) => ({ ...value, state }),
    } as never,
    async (_listing: StandardListing, _url: string, init: RequestInit) => {
      if (!claimed || typeof init.body !== "string") {
        throw new Error("Dispatch was not serialized");
      }
      args.capture?.(claimed, init.body);
      return new Response(null, { status: 503 });
    },
    hash("0"),
  );
}

describe("StandardRailDispatchV2 service handoff", () => {
  it("signs and serializes exact evidence positions and sequence", async () => {
    let captured: SignedEnvelope<StandardRailDispatchV2, 2> | null = null;
    let body = "";
    await service({ capture: (dispatch, serialized) => {
      captured = dispatch;
      body = serialized;
    } }).dispatch(order(), listing(), { sku: "one" }, hash("1"), evidence());

    expect(captured).not.toBeNull();
    const dispatch = parseStandardRailDispatchV2(captured);
    expect(Object.keys(dispatch.payload).sort()).toEqual([...STANDARD_DISPATCH_V2_KEYS].sort());
    expect(dispatch.payload).toMatchObject({
      settlementTxHash: hash("a"),
      depositBlockNumber: "101",
      depositBlockHash: hash("b"),
      depositTransactionIndex: 2,
      depositLogIndex: 3,
      releaseTxHash: hash("d"),
      releaseBlockNumber: "102",
      releaseBlockHash: hash("e"),
      releaseTransactionIndex: 4,
      releaseLogIndex: 5,
      releaseSequence: "8",
    });
    const wire = JSON.parse(body) as {
      evidenceBundle: { release: Record<string, unknown> };
    };
    expect(wire.evidenceBundle.release.releaseSequence).toBe("8");
    expect("providerNetAmount" in wire.evidenceBundle.release).toBe(false);
  });

  it("atomically replaces only a due refused claim and preserves accepted claims", async () => {
    let captured: SignedEnvelope<StandardRailDispatchV2, 2> | null = null;
    await service({ capture: (dispatch) => { captured = dispatch; } })
      .dispatch(order(), listing(), {}, hash("1"), evidence());
    const dispatch = parseStandardRailDispatchV2(captured);
    const schema = `dispatch_retry_${randomUUID().replaceAll("-", "")}`;
    const connectionString = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:password@localhost:5433/daski_gateway_test";
    const bootstrap = createPool({ connectionString, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString, searchPath: `${schema},public`, max: 3 });
    try {
      await runMigrations(pool);
      await pool.query(`INSERT INTO standard_orders (
        order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,
        binding_profile,listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,
        canonical_quote,canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,
        rail_epoch,listing_epoch,expires_at)
        VALUES ('order-1',$1,'handle',$1,'DISPATCH_STARTED','7','outcome','recipe-bound-v2',$1,$1,'{}',$1,
          '{}',$1,'{}',$1,'int_12345678-1234-4123-8123-123456789abc',100,1,1,now())`, [Buffer.alloc(32, 1)]);
      await pool.query("INSERT INTO standard_dispatch_recovery (order_id,started_at) VALUES ('order-1',now())");
      const journal = new StandardRailJournal(pool);
      const claim = { orderId: "order-1", nonce: dispatch.payload.dispatchNonce,
        dispatchHash: canonicalHash(dispatch), requestHash: canonicalHash({}), dispatch, request: {} };
      expect(await journal.claimDispatch(claim)).toBe(true);
      await journal.recordDispatchRefusal("order-1", claim.dispatchHash, 409, "not_ready");
      const replacement = structuredClone(dispatch);
      replacement.payload.dispatchNonce = hash("9");
      const fresh = { ...claim, nonce: replacement.payload.dispatchNonce, dispatchHash: canonicalHash(replacement), dispatch: replacement };
      expect(await journal.claimDispatch(fresh)).toBe(false);
      expect((await journal.dispatchClaim("order-1"))!.dispatch).toEqual(dispatch);
      await pool.query("UPDATE standard_dispatch_recovery SET next_attempt_at=now()-interval '1 second'");
      expect((await Promise.all([journal.claimDispatch(fresh), journal.claimDispatch(fresh)])).sort()).toEqual([false, true]);
      expect((await journal.dispatchClaim("order-1"))!.dispatch).toEqual(replacement);
      expect((await pool.query("SELECT canonical_dispatch FROM standard_dispatch_refusals")).rows[0].canonical_dispatch).toEqual(dispatch);
      await expect(journal.resolveDispatch("order-1", "stale-task", hash("5"), claim.dispatchHash))
        .rejects.toThrow("DISPATCH_RESOLUTION_CONFLICT");
      await journal.resolveDispatch("order-1", "task", hash("5"), fresh.dispatchHash);
      await journal.resolveDispatch("order-1", "task", hash("6"), fresh.dispatchHash);
      await pool.query("UPDATE standard_dispatch_recovery SET retry_pending=true");
      expect(await journal.claimDispatch(claim)).toBe(false);
      expect((await pool.query("SELECT provider_task_id FROM standard_dispatch_claims")).rows[0].provider_task_id).toBe("task");
    } finally {
      await pool.end(); await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`); await bootstrap.end();
    }
  }, 60_000);

  it("rejects a recovered dispatch when an evidence position changes", async () => {
    let persisted: SignedEnvelope<StandardRailDispatchV2, 2> | null = null;
    await service({ capture: (dispatch) => { persisted = dispatch; } })
      .dispatch(order(), listing(), { sku: "one" }, hash("1"), evidence());
    if (!persisted) throw new Error("Dispatch fixture was not captured");
    const changed = evidence();
    changed.release.logIndex += 1;

    await expect(service({ persisted: { dispatch: persisted, request: { sku: "one" } } })
      .dispatch(order(), listing(), { sku: "one" }, hash("1"), changed))
      .rejects.toThrow(/Persisted dispatch does not match/);
  });
});


describe("dispatch refusal recovery", () => {
  function retrying(fetcher: (url: string, init: RequestInit) => Promise<Response>) {
    let persisted: { dispatch: SignedEnvelope<StandardRailDispatchV2, 2>; request: unknown } | null = null;
    const recovery = { started_at: new Date(), retry_pending: false, next_attempt_at: new Date() };
    const refusals: Array<{ status: number; reason: unknown }> = [];
    const claims: Array<SignedEnvelope<StandardRailDispatchV2, 2>> = [];
    const transition = vi.fn(async (value: StandardOrderRecord, state: StandardOrderRecord["state"]) => ({ ...value, state }));
    const resolveDispatch = vi.fn(async () => undefined);
    const dispatchListing = listing();
    dispatchListing.commitment.payload.providerAuthorityKey = privateKeyToAccount(privateKey).address;
    const dispatcher = new StandardProviderDispatch(
      { chainId: 84532 },
      { environment: "testnet", gatewayAudience: "gateway.example", dispatchPrivateKey: privateKey,
        reputationContract: address("6"), reputationOutcomeSchemaUid: hash("9"),
        quotePrivateKey: privateKey, receiptPrivateKey: privateKey, lifecyclePrivateKey: privateKey,
        releasePrivateKey: privateKey, reputationOrderPrivateKey: privateKey, reputationRelayerPrivateKey: privateKey,
        dispatchTimeoutMs: 1000, manifest: { providerIdentitySnapshots: [] } } as never,
      {
        resolveDispatch,
        dispatchRecovery: async () => recovery,
        dispatchClaim: async () => persisted,
        claimDispatch: async (claim: { dispatch: SignedEnvelope<StandardRailDispatchV2, 2>; request: unknown }) => {
          persisted = claim; claims.push(claim.dispatch); recovery.retry_pending = false; return true;
        },
        recordDispatchRefusal: async (_id: string, _hash: Hex, status: number, reason: unknown) => {
          refusals.push({ status, reason }); recovery.retry_pending = true;
          recovery.next_attempt_at = new Date(Date.now() + Math.min(60, 10 * 2 ** (refusals.length - 1)) * 1000);
        },
      } as never,
      { transition } as never,
      (_listing, url, init) => fetcher(url, init), hash("0"),
    );
    return { dispatch: (value: StandardOrderRecord) => dispatcher.dispatch(value, dispatchListing, {}, hash("1"), evidence()),
      dispatchListing, recovery, refusals, claims, transition, resolveDispatch };
  }

  it("records a 409 refusal, waits for backoff and signs a fresh envelope beyond five minutes", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => Response.json({ error: { code: "NOT_READY", reason: "registration_pending" } }, { status: 409 }));
      const driver = retrying(fetcher);
      let current = await driver.dispatch(order());
      expect(current.state).toBe("DISPATCH_STARTED");
      expect(driver.refusals).toEqual([{ status: 409, reason: { code: "NOT_READY", reason: "registration_pending" } }]);
      await driver.dispatch(current);
      expect(fetcher).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10_000);
      current = await driver.dispatch(current);
      expect(driver.claims[1]!.payload.dispatchNonce).not.toBe(driver.claims[0]!.payload.dispatchNonce);
      expect(driver.claims[1]!.issuedAt).toBe(driver.claims[0]!.issuedAt + 10);
      vi.advanceTimersByTime(301_000);
      current = await driver.dispatch(current);
      expect(current.state).toBe("DISPATCH_STARTED");
      expect(fetcher).toHaveBeenCalledTimes(3);
      vi.setSystemTime(driver.recovery.started_at.getTime() + 3600_000);
      expect((await driver.dispatch(current)).state).toBe("PROVIDER_FAILED");
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it("does not turn the incident's fast refusal into a five-minute envelope timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T21:52:34Z"));
    try {
      const driver = retrying(async () => {
        vi.setSystemTime(Date.now() + 130);
        return Response.json({ error: "provider_not_ready" }, { status: 409 });
      });
      let current = await driver.dispatch(order());
      vi.setSystemTime(new Date("2026-09-27T21:57:34Z"));
      current = await driver.dispatch(current);
      expect(current.state).toBe("DISPATCH_STARTED");
      expect(driver.claims).toHaveLength(2);
      expect(driver.claims[1]!.signature).not.toBe(driver.claims[0]!.signature);
      vi.setSystemTime(driver.recovery.started_at.getTime() + driver.dispatchListing.deadlinePolicy.fulfillmentSeconds * 1000);
      await driver.dispatch(current);
      expect(driver.transition).toHaveBeenLastCalledWith(current, "PROVIDER_FAILED", "provider_dispatch_fulfillment_deadline_elapsed");
    } finally { vi.useRealTimers(); }
  });

  it("accepts a valid signed response after a refusal without status polling", async () => {
    let calls = 0;
    const driver = retrying(async (_url, init) => {
      if (++calls === 1) return Response.json({ error: "not_ready" }, { status: 409 });
      const sent = JSON.parse(String(init.body)) as { dispatch: unknown };
      const response = { taskId: "accepted-task", dispatchHash: canonicalHash(sent.dispatch), state: "working" };
      const signature = await privateKeyToAccount(privateKey).signMessage({ message: { raw: canonicalHash(response) } });
      return Response.json({ ...response, signature });
    });
    const current = await driver.dispatch(order());
    driver.recovery.next_attempt_at = new Date(0);
    expect((await driver.dispatch(current)).state).toBe("DISPATCHED");
    expect(driver.resolveDispatch).toHaveBeenCalledOnce();
    expect(calls).toBe(2);
  });

  it.each(["timeout", "non-json-503", "malformed-409", "malformed-200"])("keeps %s ambiguous and only polls its existing hash", async (kind) => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => {
      if (kind === "timeout") throw new Error("timed out");
      return kind === "non-json-503" ? new Response("Unavailable", { status: 503 })
        : Response.json({}, { status: kind === "malformed-200" ? 200 : 409 });
    });
    const driver = retrying(fetcher);
    const current = await driver.dispatch(order());
    expect(current.state).toBe("DISPATCH_AMBIGUOUS");
    await driver.dispatch(current);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://provider.example/dispatch/status");
    expect(driver.refusals).toHaveLength(0);
    expect(driver.claims).toHaveLength(1);
  });
});
