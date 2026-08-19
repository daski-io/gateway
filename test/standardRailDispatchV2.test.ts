import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { StandardRailService } from "../src/standardRail/service.js";
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
    screeningPolicy: { providerControlledWallets: [] },
    providerControlProfile: { payload: {
      providerAudience: "provider.example",
      dispatchUrl: "https://provider.example/dispatch",
      timeoutMs: 1_000,
    } },
    deadlinePolicy: { dispatchSeconds: 60 },
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
  const instance = Object.create(StandardRailService.prototype) as Record<string, unknown>;
  Object.assign(instance, {
    appConfig: { chainId: 84532 },
    railConfig: {
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
    },
    railProfileHash: hash("0"),
    journal: {
      dispatchClaim: async () => args.persisted ?? null,
      claimDispatch: async (claim: { dispatch: SignedEnvelope<StandardRailDispatchV2, 2> }) => {
        claimed = claim.dispatch;
        return true;
      },
    },
    store: {
      transition: async (value: StandardOrderRecord, state: StandardOrderRecord["state"]) =>
        ({ ...value, state }),
    },
    providerFetch: async (_listing: StandardListing, _url: string, init: RequestInit) => {
      if (!claimed || typeof init.body !== "string") throw new Error("Dispatch was not serialized");
      args.capture?.(claimed, init.body);
      return new Response(null, { status: 503 });
    },
  });
  return instance as unknown as DispatchInvoker;
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
