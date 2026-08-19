import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { EvidenceResult, ReleaseEvidenceResult } from "../src/standardRail/evidence.js";
import type {
  SignedEnvelope,
  StandardRailDispatchV2,
  StandardRailReceiptV2,
} from "../src/standardRail/types.js";
import {
  buildStandardEvidenceBundleV2,
  parseStandardRailDispatchV2,
  parseStandardRailReceiptV2,
  STANDARD_DISPATCH_V2_KEYS,
  STANDARD_RECEIPT_V2_KEYS,
} from "../src/standardRail/wireContracts.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const address = (byte: string): Hex => `0x${byte.repeat(40)}` as Hex;

function envelope<T>(artifactType: string, payload: T): SignedEnvelope<T, 2> {
  return {
    artifactType,
    schemaVersion: 2,
    environment: "testnet",
    chainId: 84532,
    audience: address("1"),
    signerKeyId: "gateway",
    issuedAt: 1,
    validBefore: 2,
    payload,
    signature: "0x" as Hex,
  };
}

function receiptPayload(): StandardRailReceiptV2 {
  return {
    orderId: "order-1",
    state: "RELEASE_FINAL",
    payer: address("1"),
    providerAgentId: "7",
    outcomeId: "stock",
    bindingProfile: "stock-fixed-v1",
    activeRailProfileHash: hash("1"),
    listingManifestHash: hash("2"),
    providerOfferHash: hash("3"),
    quoteHash: hash("4"),
    canonicalRequestHash: hash("5"),
    orderNonce: hash("6"),
    authorizationKey: hash("7"),
    paymentPayloadHash: hash("8"),
    grossAmount: "100",
    providerNetAmount: "90",
    daskiCommissionAmount: "10",
    facilitatorConfirmationHash: hash("9"),
    settlementTxHash: hash("a"),
    depositEvidenceHash: hash("b"),
    depositBlockNumber: "101",
    depositBlockHash: hash("c"),
    depositTransactionIndex: 2,
    depositLogIndex: 3,
    releaseTxHash: hash("d"),
    releaseEvidenceHash: hash("e"),
    releaseBlockNumber: "102",
    releaseBlockHash: hash("f"),
    releaseTransactionIndex: 4,
    releaseLogIndex: 5,
    releaseSequence: "8",
  };
}

function dispatchPayload(): StandardRailDispatchV2 {
  return {
    environment: "testnet",
    chainId: 84532,
    gatewayAudience: "gateway",
    providerAudience: "provider",
    providerControlProfileHash: hash("1"),
    orderId: "order-1",
    orderKey: hash("2"),
    serviceId: hash("3"),
    reputationEligible: true,
    reputationContract: address("2"),
    outcomeSchemaUid: hash("4"),
    dispatchNonce: hash("5"),
    payer: address("1"),
    listingManifestHash: hash("6"),
    providerOfferHash: hash("7"),
    quoteHash: hash("8"),
    bindingProfile: "stock-fixed-v1",
    canonicalRequestHash: hash("9"),
    orderNonce: hash("a"),
    buyerIdentityProofHash: hash("b"),
    activeRailProfileHash: hash("c"),
    facilitatorConfirmationHash: hash("d"),
    settlementTxHash: hash("e"),
    depositEvidenceHash: hash("f"),
    depositBlockNumber: "101",
    depositBlockHash: hash("1"),
    depositTransactionIndex: 2,
    depositLogIndex: 3,
    releaseTxHash: hash("2"),
    releaseEvidenceHash: hash("3"),
    releaseBlockNumber: "102",
    releaseBlockHash: hash("4"),
    releaseTransactionIndex: 4,
    releaseLogIndex: 5,
    releaseSequence: "8",
    grossAmount: "100",
    providerNetAmount: "90",
    daskiCommissionAmount: "10",
    canonicalProviderRequestHash: hash("5"),
    dispatchDeadlineSeconds: 60,
    issuedAt: 1,
    validBefore: 61,
  };
}

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
      releaseSequence: 8n,
      providerNetAmount: 90n,
      daskiCommissionAmount: 10n,
    },
  };
}

describe("V2 wire contracts", () => {
  it("accepts only the exact StandardRailReceiptV2 shape", () => {
    const receipt = envelope("StandardRailReceiptV2", receiptPayload());
    expect(parseStandardRailReceiptV2(receipt)).toEqual(receipt);
    expect(Object.keys(receipt.payload).sort()).toEqual([...STANDARD_RECEIPT_V2_KEYS].sort());

    expect(() => parseStandardRailReceiptV2({
      ...receipt,
      artifactType: "StandardRailReceiptV1",
    })).toThrow(/StandardRailReceiptV2/);
    expect(() => parseStandardRailReceiptV2({
      ...receipt,
      payload: { ...receipt.payload, unexpected: true },
    })).toThrow(/closed V2 shape/);
    expect(() => parseStandardRailReceiptV2({
      ...receipt,
      payload: { ...receipt.payload, authorizationKey: null },
    })).toThrow(/payload is invalid/);
    expect(() => parseStandardRailReceiptV2({
      ...receipt,
      payload: { ...receipt.payload, paymentPayloadHash: null },
    })).toThrow(/payload is invalid/);
  });

  it("accepts only the exact StandardRailDispatchV2 shape", () => {
    const dispatch = envelope("StandardRailDispatchV2", dispatchPayload());
    dispatch.audience = dispatch.payload.providerAudience;
    dispatch.issuedAt = dispatch.payload.issuedAt;
    dispatch.validBefore = dispatch.payload.validBefore;
    expect(parseStandardRailDispatchV2(dispatch)).toEqual(dispatch);
    expect(Object.keys(dispatch.payload).sort()).toEqual([...STANDARD_DISPATCH_V2_KEYS].sort());

    expect(() => parseStandardRailDispatchV2({
      ...dispatch,
      schemaVersion: 1,
    })).toThrow(/StandardRailDispatchV2/);
    const { releaseSequence: _removed, ...withoutSequence } = dispatch.payload;
    expect(() => parseStandardRailDispatchV2({
      ...dispatch,
      payload: withoutSequence,
    })).toThrow(/closed V2 shape/);
  });

  it("builds a closed deterministic provider evidence bundle", () => {
    const live = evidence();
    const recovered = evidence();
    const first = buildStandardEvidenceBundleV2(live.deposit, live.release);
    const restarted = buildStandardEvidenceBundleV2(recovered.deposit, recovered.release);

    expect(first).toEqual(restarted);
    expect(Object.keys(first.deposit).sort()).toEqual([
      "blockHash", "blockNumber", "canonicalEvidence", "evidenceHash", "logIndex",
      "sources", "transactionHash", "transactionIndex",
    ].sort());
    expect(Object.keys(first.release).sort()).toEqual([
      "blockHash", "blockNumber", "canonicalEvidence", "evidenceHash", "logIndex",
      "releaseSequence", "sources", "transactionHash", "transactionIndex",
    ].sort());
    expect(first.release.releaseSequence).toBe("8");
    expect("providerNetAmount" in first.release).toBe(false);
  });
});
