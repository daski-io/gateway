import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import {
  StandardConfirmationState,
  ZERO_UID,
  type ConfirmationReadClient,
} from "../src/standardRail/confirmationState.js";
import {
  FINAL_ATTESTATION_WARNING,
  StandardConfirmations,
} from "../src/standardRail/confirmations.js";
import type { StandardOrderRecord } from "../src/standardRail/types.js";

/// Spec B6 and B7: submission counting in both modes, sponsored refused for a
/// contract signer, an invalid delegated signature reserves nothing, separate
/// attestation and revocation allowances, finalized-only storage, a latest
/// read never stored, and the capability epoch moving only on a final change.
const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const payerKey = privateKeyToAccount(`0x${"11".repeat(32)}`);
const strangerKey = privateKeyToAccount(`0x${"22".repeat(32)}`);
const hash = (digit: string): Hex => `0x${digit.repeat(64)}` as Hex;
const address = (digit: string): Address => getAddress(`0x${digit.repeat(40)}`);
const EAS = address("e");
const REPUTATION = address("f");
const SCHEMA = hash("5");
const easDirectAbi = parseAbi([
  "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)",
  "function revoke((bytes32 schema,(bytes32 uid,uint256 value) data) request) payable",
]);

interface ChainRecordState {
  block: bigint;
  confirmation: number;
  submissionsUsed: number;
  currentUid: Hex;
}

const chain = {
  finalized: { block: 100n, confirmation: 0, submissionsUsed: 0, currentUid: ZERO_UID } as ChainRecordState,
  latest: { block: 105n, confirmation: 0, submissionsUsed: 0, currentUid: ZERO_UID } as ChainRecordState,
  easNonce: 7n,
  registered: true,
};

function blockHash(tag: "finalized" | "latest", block: bigint): Hex {
  return `0x${createHash("sha256").update(`${tag}:${block}`).digest("hex")}` as Hex;
}

const readClient: ConfirmationReadClient = {
  getBlock: async ({ blockTag }) => ({
    number: chain[blockTag].block,
    hash: blockHash(blockTag, chain[blockTag].block),
  }),
  readContract: async ({ blockHash: pinned }) => {
    const tag = pinned === blockHash("finalized", chain.finalized.block) ? "finalized" : "latest";
    if (pinned !== blockHash(tag, chain[tag].block)) throw new Error("block hash is not canonical");
    const state = chain[tag];
    return {
      orderKey: chain.registered ? hash("1") : ZERO_UID,
      payer: payerKey.address,
      providerOwner: address("a"),
      providerAgentWallet: address("b"),
      confirmation: state.confirmation,
      confirmationSubmissions: state.submissionsUsed,
      currentConfirmationUid: state.currentUid,
    };
  },
};

const schemaName = `confirmations_${randomUUID().replaceAll("-", "")}`;
let bootstrap: Pool;
let pool: Pool;
let bumpEpoch: ReturnType<typeof vi.fn>;
let state: StandardConfirmationState;

const orderId = "ord_11111111-1111-4111-8111-111111111111";
const order = {
  orderId,
  orderKey: hash("1"),
  payer: payerKey.address.toLowerCase() as Hex,
  outcomeId: "register-domain",
} as unknown as StandardOrderRecord;

function config(overrides: Partial<StandardRailConfig> = {}): StandardRailConfig {
  return {
    evidenceRpcUrls: ["https://rpc.example"],
    reputationContract: REPUTATION,
    easAddress: EAS,
    reputationConfirmationSchemaUid: SCHEMA,
    confirmationDeadlineSeconds: 300,
    confirmationMaxPerOrder: 3,
    confirmationMaxPerPayerPerDay: 20,
    confirmationMaxGlobalPerDay: 500,
    ...overrides,
  } as unknown as StandardRailConfig;
}

function confirmations(overrides: Partial<StandardRailConfig> = {}): StandardConfirmations {
  return new StandardConfirmations(pool, config(overrides), baseSepolia, state, {
    readContract: async () => chain.easNonce,
  });
}

beforeAll(async () => {
  bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schemaName}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: `${schemaName},public`, max: 5 });
  await runMigrations(pool);
  await pool.query(
    `INSERT INTO standard_orders (
       order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
       listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
       canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,
       listing_epoch,expires_at,payer)
     VALUES ($1,$2,'handle-1',$3,'FULFILLED','42','register-domain','recipe-bound-v2',$4,$5,'{}',$6,'{}',
       $7,'{}',$8,'int_11111111-1111-4111-8111-111111111111',5000000,1,1,now()+interval '1 day',$9)`,
    [orderId, Buffer.from(hash("1").slice(2), "hex"), Buffer.alloc(32, 9), Buffer.alloc(32, 2),
      Buffer.alloc(32, 3), Buffer.alloc(32, 4), Buffer.alloc(32, 6), Buffer.alloc(32, 8),
      payerKey.address.toLowerCase()],
  );
}, 120_000);

beforeEach(() => {
  bumpEpoch = vi.fn(async () => undefined);
  state = new StandardConfirmationState(
    pool, config(), baseSepolia, bumpEpoch as unknown as (orderId: string) => Promise<void>,
    [{ host: "rpc.example", client: readClient }],
  );
  chain.finalized = { block: 100n, confirmation: 0, submissionsUsed: 0, currentUid: ZERO_UID };
  chain.latest = { block: 105n, confirmation: 0, submissionsUsed: 0, currentUid: ZERO_UID };
  chain.easNonce = 7n;
  chain.registered = true;
});

afterAll(async () => {
  await pool?.end();
  await bootstrap.query(`DROP SCHEMA "${schemaName}" CASCADE`).catch(() => undefined);
  await bootstrap.end();
});

const eoa = { verifiedVia: "recovery" as const };
const contract = { verifiedVia: "erc1271" as const };

async function signPreparation(typedData: Record<string, unknown>, account = payerKey): Promise<Hex> {
  return account.signTypedData(typedData as never);
}

async function sponsorshipRows() {
  const result = await pool.query<{ state: string; operation: string }>(
    `SELECT s.state,p.operation FROM standard_confirmation_sponsorships s
       JOIN standard_confirmation_preparations p ON p.preparation_id=s.preparation_id ORDER BY s.created_at`,
  );
  return result.rows;
}

async function resetSponsorships() {
  await pool.query("DELETE FROM standard_confirmation_sponsorships");
  await pool.query("DELETE FROM standard_reputation_operations WHERE kind='confirmation'");
  await pool.query("DELETE FROM standard_confirmation_preparations");
}

/** Prepare, sign, and submit one sponsored operation; returns the pending refusal. */
async function sponsoredSubmit(
  subject: StandardConfirmations,
  action: "confirmation" | "revoke-confirmation",
  label: "Confirmed" | "NotConfirmed" = "Confirmed",
  acknowledge = false,
) {
  const prepared = await subject.handle(order, action, action === "confirmation"
    ? { phase: "prepare", submission: "sponsored", confirmation: label, acknowledgeFinalTransition: acknowledge }
    : { phase: "prepare", submission: "sponsored" }, eoa);
  const typedData = prepared.result.signableTypedData as Record<string, unknown>;
  if (!typedData) return { prepared, submitted: null };
  const signature = await signPreparation(typedData);
  const submitted = await subject.handle(order, action, {
    phase: "submit", submission: "sponsored", preparationId: prepared.result.preparationId, signature,
  }, eoa).catch((error: unknown) => error as { code?: string; chainEligible?: boolean });
  return { prepared, submitted };
}

describe("delivery confirmation modes", () => {
  it("counts submissions: attest while used < 3, revoke whenever a confirmation is current", async () => {
    const subject = confirmations();
    chain.latest = { ...chain.latest, submissionsUsed: 3, currentUid: hash("c") };
    await expect(subject.handle(order, "confirmation", {
      phase: "prepare", submission: "direct", confirmation: "Confirmed", acknowledgeFinalTransition: true,
    }, contract)).rejects.toMatchObject({ code: "CONFIRMATION_SUBMISSION_LIMIT" });
    const revoke = await subject.handle(order, "revoke-confirmation", {
      phase: "prepare", submission: "direct",
    }, contract);
    expect(revoke.result).toMatchObject({ submissionsUsed: 3, revocationAvailable: true, finalAttestation: false });
    chain.latest = { ...chain.latest, submissionsUsed: 3, currentUid: ZERO_UID };
    await expect(subject.handle(order, "revoke-confirmation", { phase: "prepare", submission: "direct" }, contract))
      .rejects.toMatchObject({ code: "CONFIRMATION_NOT_ACTIVE" });
  });

  it("marks the third attestation final with the exact warning and gates it on acknowledgement", async () => {
    const subject = confirmations();
    chain.latest = { ...chain.latest, submissionsUsed: 2, currentUid: hash("c") };
    const unacknowledged = await subject.handle(order, "confirmation", {
      phase: "prepare", submission: "direct", confirmation: "NotConfirmed", acknowledgeFinalTransition: false,
    }, contract);
    expect(unacknowledged.result).toMatchObject({
      submissionsUsed: 2, finalAttestation: true, warning: FINAL_ATTESTATION_WARNING, call: null,
    });
    expect(FINAL_ATTESTATION_WARNING.message)
      .toBe("this is the last confirmation you can submit; it can still be revoked");
    const acknowledged = await subject.handle(order, "confirmation", {
      phase: "prepare", submission: "direct", confirmation: "NotConfirmed", acknowledgeFinalTransition: true,
    }, contract);
    expect(acknowledged.result.call).toMatchObject({ function: "attest" });
    // Revocation never asks for the acknowledgement and never restores capacity.
    const revoke = await subject.handle(order, "revoke-confirmation", { phase: "prepare", submission: "direct" }, contract);
    expect(revoke.result).toMatchObject({ finalAttestation: false, submissionsUsed: 2 });
  });

  it("refuses sponsored submission for a contract signer before any chain read", async () => {
    const subject = confirmations();
    chain.registered = false;
    await expect(subject.handle(order, "confirmation", {
      phase: "prepare", submission: "sponsored", confirmation: "Confirmed", acknowledgeFinalTransition: false,
    }, contract)).rejects.toMatchObject({ code: "CONFIRMATION_SPONSORED_REQUIRES_EOA" });
    await expect(subject.handle(order, "confirmation", {
      phase: "submit", submission: "sponsored", preparationId: randomUUID(), signature: `0x${"11".repeat(65)}`,
    }, contract)).rejects.toMatchObject({ code: "CONFIRMATION_SPONSORED_REQUIRES_EOA" });
  });

  it("returns the closed direct-mode call computed from the chain record, with no row written", async () => {
    const subject = confirmations();
    chain.latest = { ...chain.latest, submissionsUsed: 1, currentUid: hash("c") };
    const prepared = await subject.handle(order, "confirmation", {
      phase: "prepare", submission: "direct", confirmation: "Confirmed", acknowledgeFinalTransition: false,
    }, contract);
    const call = prepared.result.call as {
      chainId: number; to: Address; function: string; calldata: Hex; value: string;
      request: { schema: Hex; data: Record<string, unknown> };
    };
    expect(call).toMatchObject({ chainId: 84532, to: EAS, function: "attest", value: "0" });
    expect(call.request.data).toMatchObject({ recipient: address("b"), refUID: hash("c"), revocable: true });
    const decoded = decodeFunctionData({ abi: easDirectAbi, data: call.calldata });
    expect(decoded.functionName).toBe("attest");
    expect((decoded.args[0] as { data: { refUID: Hex } }).data.refUID).toBe(hash("c"));
    expect(prepared.result.observedBlock).toEqual({ number: "105", hash: blockHash("latest", 105n) });
    expect(prepared.result).not.toHaveProperty("preparationId");
    const rows = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM standard_confirmation_preparations");
    expect(rows.rows[0]!.n).toBe(0);
    const revoke = await subject.handle(order, "revoke-confirmation", { phase: "prepare", submission: "direct" }, contract);
    const revokeCall = revoke.result.call as { calldata: Hex; function: string };
    expect(decodeFunctionData({ abi: easDirectAbi, data: revokeCall.calldata }).functionName).toBe("revoke");
    expect(prepared.finalChanged).toBe(false);
    expect(bumpEpoch).not.toHaveBeenCalled();
  });

  it("requires submission next to phase and refuses submit in direct mode", async () => {
    const subject = confirmations();
    await expect(subject.handle(order, "confirmation", {
      phase: "prepare", confirmation: "Confirmed", acknowledgeFinalTransition: false,
    }, eoa)).rejects.toMatchObject({ code: "CONFIRMATION_REQUEST_INVALID" });
    await expect(subject.handle(order, "confirmation", {
      phase: "submit", submission: "direct", preparationId: randomUUID(), signature: `0x${"11".repeat(65)}`,
    }, eoa)).rejects.toMatchObject({ code: "CONFIRMATION_REQUEST_INVALID" });
  });

  it("validates the delegated signature strictly before any reservation", async () => {
    await resetSponsorships();
    const subject = confirmations();
    const prepared = await subject.handle(order, "confirmation", {
      phase: "prepare", submission: "sponsored", confirmation: "Confirmed", acknowledgeFinalTransition: false,
    }, eoa);
    const typedData = prepared.result.signableTypedData as Record<string, unknown>;
    const wrongSigner = await signPreparation(typedData, strangerKey);
    for (const signature of [wrongSigner, `0x${"ab".repeat(64)}`, `0x${"ab".repeat(66)}`]) {
      await expect(subject.handle(order, "confirmation", {
        phase: "submit", submission: "sponsored", preparationId: prepared.result.preparationId, signature,
      }, eoa)).rejects.toMatchObject({ code: "CONFIRMATION_SIGNATURE_INVALID" });
    }
    expect(await sponsorshipRows()).toEqual([]);
    const preparation = await pool.query<{ consumed_at: Date | null }>(
      "SELECT consumed_at FROM standard_confirmation_preparations WHERE preparation_id=$1",
      [prepared.result.preparationId],
    );
    expect(preparation.rows[0]?.consumed_at).toBeNull();
    // The valid signature then reserves the sponsorship and reports the queued submission.
    const signature = await signPreparation(typedData);
    await expect(subject.handle(order, "confirmation", {
      phase: "submit", submission: "sponsored", preparationId: prepared.result.preparationId, signature,
    }, eoa)).rejects.toMatchObject({ code: "CONFIRMATION_SUBMISSION_PENDING", retryable: true });
    expect(await sponsorshipRows()).toEqual([{ state: "reserved", operation: "attest-confirmation" }]);
    const intent = await pool.query<{ canonical_intent: { submissionsUsed: number; operation: string } }>(
      "SELECT canonical_intent FROM standard_reputation_operations WHERE kind='confirmation'",
    );
    expect(intent.rows[0]?.canonical_intent).toMatchObject({ operation: "attest-confirmation", submissionsUsed: 0 });
  });

  it("sponsors a revocation after three charged attestations and refuses a fourth attestation budget", async () => {
    await resetSponsorships();
    const subject = confirmations();
    for (let used = 0; used < 3; used += 1) {
      chain.latest = { ...chain.latest, submissionsUsed: used, currentUid: used === 0 ? ZERO_UID : hash(String(used)) };
      chain.easNonce = BigInt(10 + used);
      const { submitted } = await sponsoredSubmit(subject, "confirmation", "Confirmed", used === 2);
      expect(submitted).toMatchObject({ code: "CONFIRMATION_SUBMISSION_PENDING" });
      await pool.query("UPDATE standard_confirmation_sponsorships SET state='charged'");
    }
    expect((await sponsorshipRows()).map((row) => row.operation))
      .toEqual(["attest-confirmation", "attest-confirmation", "attest-confirmation"]);
    // The chain is at three submissions with a current confirmation.
    chain.latest = { ...chain.latest, submissionsUsed: 3, currentUid: hash("3") };
    chain.easNonce = 20n;
    const { submitted } = await sponsoredSubmit(subject, "revoke-confirmation");
    expect(submitted).toMatchObject({ code: "CONFIRMATION_SUBMISSION_PENDING" });
    expect((await sponsorshipRows()).map((row) => row.operation).at(-1)).toBe("revoke-confirmation");
  });

  it("answers an exhausted attestation budget with CONFIRMATION_SPONSORSHIP_LIMIT and chainEligible", async () => {
    await resetSponsorships();
    const subject = confirmations({ confirmationMaxPerOrder: 1 });
    chain.easNonce = 30n;
    const first = await sponsoredSubmit(subject, "confirmation");
    expect(first.submitted).toMatchObject({ code: "CONFIRMATION_SUBMISSION_PENDING" });
    await pool.query("UPDATE standard_confirmation_sponsorships SET state='charged'");
    chain.latest = { ...chain.latest, submissionsUsed: 1, currentUid: hash("1") };
    chain.easNonce = 31n;
    const second = await sponsoredSubmit(subject, "confirmation");
    expect(second.submitted).toMatchObject({ code: "CONFIRMATION_SPONSORSHIP_LIMIT", chainEligible: true });
    expect((await sponsorshipRows()).filter((row) => row.state === "reserved")).toEqual([]);
    // A revocation has its own allowance and still goes through.
    chain.easNonce = 32n;
    const revoke = await sponsoredSubmit(subject, "revoke-confirmation");
    expect(revoke.submitted).toMatchObject({ code: "CONFIRMATION_SUBMISSION_PENDING" });
  });

  it("refuses a stale preparation once the chain moved on", async () => {
    await resetSponsorships();
    const subject = confirmations();
    chain.easNonce = 40n;
    const prepared = await subject.handle(order, "confirmation", {
      phase: "prepare", submission: "sponsored", confirmation: "Confirmed", acknowledgeFinalTransition: false,
    }, eoa);
    chain.latest = { ...chain.latest, submissionsUsed: 1, currentUid: hash("1") };
    const signature = await signPreparation(prepared.result.signableTypedData as Record<string, unknown>);
    await expect(subject.handle(order, "confirmation", {
      phase: "submit", submission: "sponsored", preparationId: prepared.result.preparationId, signature,
    }, eoa)).rejects.toMatchObject({ code: "CONFIRMATION_PREPARATION_STALE" });
    expect(await sponsorshipRows()).toEqual([]);
  });
});

describe("confirmation state (finalized-only storage)", () => {
  it("stores the finalized read, returns the latest read unstored, and bumps the epoch only on change", async () => {
    await pool.query("DELETE FROM standard_reputation_confirmations");
    const subject = confirmations();
    chain.finalized = { block: 100n, confirmation: 1, submissionsUsed: 1, currentUid: hash("1") };
    chain.latest = { block: 105n, confirmation: 2, submissionsUsed: 2, currentUid: hash("2") };
    const first = await subject.handle(order, "confirmation", { phase: "check", submission: "direct" }, contract);
    expect(first.result).toEqual({
      orderKey: hash("1"),
      lastObserved: { state: "NotConfirmed", currentUid: hash("2"), submissionsUsed: 2 },
      confirmedCurrent: { state: "Confirmed", currentUid: hash("1"), submissionsUsed: 1 },
      submissionsUsed: 1,
      observedBlock: { number: "105", hash: blockHash("latest", 105n) },
      finalizedBlock: { number: "100", hash: blockHash("finalized", 100n) },
    });
    expect(first.finalChanged).toBe(true);
    expect(bumpEpoch).toHaveBeenCalledTimes(1);
    expect(await state.stored(orderId)).toEqual({
      state: "Confirmed", currentUid: hash("1"), submissionsUsed: 1,
      blockNumber: "100", blockHash: blockHash("finalized", 100n),
    });

    // Same finalized block again: nothing stored, no epoch move.
    const repeat = await subject.handle(order, "confirmation", { phase: "check", submission: "sponsored" }, eoa);
    expect(repeat.finalChanged).toBe(false);
    expect(bumpEpoch).toHaveBeenCalledTimes(1);

    // A higher finalized block with the same state: stored, epoch unchanged.
    chain.finalized = { block: 110n, confirmation: 1, submissionsUsed: 1, currentUid: hash("1") };
    const moved = await subject.handle(order, "confirmation", { phase: "check", submission: "direct" }, contract);
    expect(moved.finalChanged).toBe(false);
    expect((await state.stored(orderId))?.blockNumber).toBe("110");
    expect(bumpEpoch).toHaveBeenCalledTimes(1);

    // A lagging endpoint's lower finalized block never overwrites.
    chain.finalized = { block: 90n, confirmation: 0, submissionsUsed: 0, currentUid: ZERO_UID };
    const lagging = await subject.handle(order, "confirmation", { phase: "check", submission: "direct" }, contract);
    expect(lagging.result).toMatchObject({ confirmedCurrent: { currentUid: hash("1") }, submissionsUsed: 1 });
    expect((await state.stored(orderId))?.blockNumber).toBe("110");

    // The finalized state catches up with the latest one: stored and bumped.
    chain.finalized = { block: 120n, confirmation: 2, submissionsUsed: 2, currentUid: hash("2") };
    const caughtUp = await subject.handle(order, "confirmation", { phase: "check", submission: "direct" }, contract);
    expect(caughtUp.finalChanged).toBe(true);
    expect(bumpEpoch).toHaveBeenCalledTimes(2);
    expect(await state.stored(orderId)).toMatchObject({ currentUid: hash("2"), submissionsUsed: 2, blockNumber: "120" });
  });

  it("serializes concurrent first observations so a lower block never overwrites a higher one", async () => {
    await pool.query("DELETE FROM standard_reputation_confirmations");
    // The higher observation holds its transaction open past the INSERT until
    // the lower one has been issued; FOR UPDATE alone cannot lock the absent
    // row, so the per-order advisory lock is what makes the lower writer wait.
    let releaseHigh!: () => void;
    const highMayCommit = new Promise<void>((resolve) => { releaseHigh = resolve; });
    let highInserted!: () => void;
    const highHasInserted = new Promise<void>((resolve) => { highInserted = resolve; });
    const gated = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: async (text: string, values?: unknown[]) => {
            const result = await client.query(text, values);
            if (text.includes("INSERT INTO standard_reputation_confirmations")) highInserted();
            if (text === "COMMIT") await highMayCommit;
            return result;
          },
        };
      },
    } as unknown as Pool;
    const high = new StandardConfirmationState(gated, config(), baseSepolia, bumpEpoch as never, [{ host: "rpc.example", client: readClient }]);
    const observation = (block: string) => ({
      state: "Confirmed" as const, currentUid: hash("4"), submissionsUsed: 1, blockNumber: block, blockHash: blockHash("finalized", BigInt(block)),
    });
    const highRun = high.record({ orderId, orderKey: hash("1") }, observation("200"));
    await highHasInserted;
    const lowRun = state.record({ orderId, orderKey: hash("1") }, observation("100"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseHigh();
    const [highResult, lowResult] = await Promise.all([highRun, lowRun]);
    expect(highResult).toMatchObject({ stored: true, changed: true, final: { blockNumber: "200" } });
    expect(lowResult).toEqual({ stored: false, changed: false, final: highResult.final });
    expect((await state.stored(orderId))?.blockNumber).toBe("200");
  });

  it("reconciles from a finalized read the way the sponsored worker does", async () => {
    await pool.query("DELETE FROM standard_reputation_confirmations");
    chain.finalized = { block: 200n, confirmation: 1, submissionsUsed: 1, currentUid: hash("7") };
    chain.latest = { block: 260n, confirmation: 0, submissionsUsed: 2, currentUid: ZERO_UID };
    const outcome = await state.reconcile({ orderId, orderKey: hash("1") });
    expect(outcome).toEqual({
      final: { state: "Confirmed", currentUid: hash("7"), submissionsUsed: 1, blockNumber: "200", blockHash: blockHash("finalized", 200n) },
      changed: true,
    });
    expect(bumpEpoch).toHaveBeenCalledWith(orderId);
    // The latest read is not what got stored.
    expect((await state.stored(orderId))?.submissionsUsed).toBe(1);
    await expect(state.reconcile({ orderId, orderKey: hash("1") })).resolves.toMatchObject({ changed: false });
  });
});
