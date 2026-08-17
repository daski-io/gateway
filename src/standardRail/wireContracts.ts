import type { EvidenceResult, ReleaseEvidenceResult } from "./evidence.js";
import type {
  SignedEnvelope,
  StandardEvidenceBundleV2,
  StandardRailDispatchV2,
  StandardRailReceiptV2,
} from "./types.js";

const ENVELOPE_KEYS = [
  "artifactType", "schemaVersion", "environment", "chainId", "audience",
  "signerKeyId", "issuedAt", "validBefore", "payload", "signature",
] as const;

export const STANDARD_RECEIPT_V2_KEYS = [
  "orderId", "state", "payer", "providerAgentId", "outcomeId", "bindingProfile",
  "activeRailProfileHash", "listingManifestHash", "providerOfferHash", "quoteHash",
  "canonicalRequestHash", "orderNonce", "authorizationKey", "paymentPayloadHash",
  "grossAmount", "providerNetAmount", "daskiCommissionAmount",
  "facilitatorConfirmationHash", "settlementTxHash", "depositEvidenceHash",
  "depositBlockNumber", "depositBlockHash", "depositTransactionIndex", "depositLogIndex",
  "releaseTxHash", "releaseEvidenceHash", "releaseBlockNumber", "releaseBlockHash",
  "releaseTransactionIndex", "releaseLogIndex", "releaseSequence",
] as const;

export const STANDARD_DISPATCH_V2_KEYS = [
  "environment", "chainId", "gatewayAudience", "providerAudience",
  "providerControlProfileHash", "orderId", "orderKey", "serviceId", "reputationEligible",
  "reputationContract", "outcomeSchemaUid", "dispatchNonce", "payer",
  "listingManifestHash", "providerOfferHash", "quoteHash", "bindingProfile",
  "canonicalRequestHash", "orderNonce", "buyerIdentityProofHash", "activeRailProfileHash",
  "facilitatorConfirmationHash", "settlementTxHash", "depositBlockNumber",
  "depositBlockHash", "depositTransactionIndex", "depositLogIndex", "depositEvidenceHash",
  "releaseTxHash", "releaseBlockNumber", "releaseBlockHash", "releaseTransactionIndex",
  "releaseLogIndex", "releaseSequence", "releaseEvidenceHash", "grossAmount",
  "providerNetAmount", "daskiCommissionAmount", "canonicalProviderRequestHash",
  "dispatchDeadlineSeconds", "issuedAt", "validBefore",
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected) throw new Error(`${label} is not a closed V2 shape`);
}

function isHash(value: unknown): boolean {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: unknown): boolean {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isUint(value: unknown): boolean {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function isIndex(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function envelopePayload(
  value: unknown,
  artifactType: "StandardRailReceiptV2" | "StandardRailDispatchV2",
): Record<string, unknown> {
  const envelope = record(value, artifactType);
  exactKeys(envelope, ENVELOPE_KEYS, artifactType);
  if (
    envelope.artifactType !== artifactType || envelope.schemaVersion !== 2 ||
    typeof envelope.environment !== "string" || !envelope.environment ||
    !Number.isSafeInteger(envelope.chainId) || Number(envelope.chainId) < 1 ||
    typeof envelope.audience !== "string" || !envelope.audience ||
    typeof envelope.signerKeyId !== "string" || !envelope.signerKeyId ||
    !Number.isSafeInteger(envelope.issuedAt) || !Number.isSafeInteger(envelope.validBefore) ||
    Number(envelope.validBefore) <= Number(envelope.issuedAt) ||
    typeof envelope.signature !== "string"
  ) throw new Error(`${artifactType} envelope is invalid`);
  return record(envelope.payload, `${artifactType} payload`);
}

export function parseStandardRailReceiptV2(
  value: unknown,
): SignedEnvelope<StandardRailReceiptV2, 2> {
  const payload = envelopePayload(value, "StandardRailReceiptV2");
  const envelope = value as Record<string, unknown>;
  exactKeys(payload, STANDARD_RECEIPT_V2_KEYS, "StandardRailReceiptV2 payload");
  if (
    payload.state !== "RELEASE_FINAL" || !isText(payload.orderId) ||
    !isText(payload.providerAgentId) || !isText(payload.outcomeId) ||
    !isAddress(payload.payer) || envelope.audience !== payload.payer ||
    !["stock-fixed-v1", "recipe-bound-v1"].includes(String(payload.bindingProfile)) ||
    ![
      payload.activeRailProfileHash, payload.listingManifestHash, payload.providerOfferHash,
      payload.quoteHash, payload.canonicalRequestHash, payload.orderNonce,
      payload.facilitatorConfirmationHash,
    ].every(isHash) ||
    !isHash(payload.authorizationKey) || !isHash(payload.paymentPayloadHash) ||
    !isHash(payload.settlementTxHash) || !isHash(payload.depositEvidenceHash) ||
    !isHash(payload.depositBlockHash) || !isIndex(payload.depositTransactionIndex) ||
    !isIndex(payload.depositLogIndex) || !isHash(payload.releaseTxHash) ||
    !isHash(payload.releaseEvidenceHash) || !isHash(payload.releaseBlockHash) ||
    !isIndex(payload.releaseTransactionIndex) || !isIndex(payload.releaseLogIndex) ||
    !isUint(payload.depositBlockNumber) || !isUint(payload.releaseBlockNumber) ||
    !isUint(payload.releaseSequence) || BigInt(String(payload.releaseSequence)) < 1n ||
    !isUint(payload.grossAmount) || !isUint(payload.providerNetAmount) ||
    !isUint(payload.daskiCommissionAmount) || BigInt(String(payload.grossAmount)) < 1n ||
    BigInt(String(payload.providerNetAmount)) < 1n ||
    BigInt(String(payload.daskiCommissionAmount)) < 1n ||
    BigInt(String(payload.providerNetAmount)) + BigInt(String(payload.daskiCommissionAmount)) !==
      BigInt(String(payload.grossAmount))
  ) throw new Error("StandardRailReceiptV2 payload is invalid");
  return value as SignedEnvelope<StandardRailReceiptV2, 2>;
}

export function parseStandardRailDispatchV2(
  value: unknown,
): SignedEnvelope<StandardRailDispatchV2, 2> {
  const payload = envelopePayload(value, "StandardRailDispatchV2");
  const envelope = value as Record<string, unknown>;
  exactKeys(payload, STANDARD_DISPATCH_V2_KEYS, "StandardRailDispatchV2 payload");
  if (
    payload.environment !== envelope.environment || payload.chainId !== envelope.chainId ||
    payload.providerAudience !== envelope.audience ||
    ![
      payload.gatewayAudience, payload.providerAudience, payload.orderId,
    ].every(isText) ||
    ![
      payload.providerControlProfileHash, payload.orderKey, payload.serviceId,
      payload.outcomeSchemaUid, payload.dispatchNonce, payload.listingManifestHash,
      payload.providerOfferHash, payload.quoteHash, payload.canonicalRequestHash,
      payload.orderNonce, payload.buyerIdentityProofHash, payload.activeRailProfileHash,
      payload.facilitatorConfirmationHash, payload.canonicalProviderRequestHash,
    ].every(isHash) ||
    !isAddress(payload.reputationContract) || !isAddress(payload.payer) ||
    typeof payload.reputationEligible !== "boolean" ||
    !["stock-fixed-v1", "recipe-bound-v1"].includes(String(payload.bindingProfile)) ||
    !isHash(payload.settlementTxHash) || !isHash(payload.depositEvidenceHash) ||
    !isHash(payload.depositBlockHash) || !isIndex(payload.depositTransactionIndex) ||
    !isIndex(payload.depositLogIndex) || !isHash(payload.releaseTxHash) ||
    !isHash(payload.releaseEvidenceHash) || !isHash(payload.releaseBlockHash) ||
    !isIndex(payload.releaseTransactionIndex) || !isIndex(payload.releaseLogIndex) ||
    !isUint(payload.depositBlockNumber) || !isUint(payload.releaseBlockNumber) ||
    !isUint(payload.releaseSequence) || BigInt(String(payload.releaseSequence)) < 1n ||
    !isUint(payload.grossAmount) || !isUint(payload.providerNetAmount) ||
    !isUint(payload.daskiCommissionAmount) || BigInt(String(payload.grossAmount)) < 1n ||
    BigInt(String(payload.providerNetAmount)) < 1n ||
    BigInt(String(payload.daskiCommissionAmount)) < 1n ||
    BigInt(String(payload.providerNetAmount)) + BigInt(String(payload.daskiCommissionAmount)) !==
      BigInt(String(payload.grossAmount)) ||
    !Number.isSafeInteger(payload.dispatchDeadlineSeconds) ||
    Number(payload.dispatchDeadlineSeconds) < 1 ||
    payload.issuedAt !== envelope.issuedAt || payload.validBefore !== envelope.validBefore
  ) throw new Error("StandardRailDispatchV2 payload is invalid");
  return value as SignedEnvelope<StandardRailDispatchV2, 2>;
}

export function buildStandardEvidenceBundleV2(
  deposit: EvidenceResult,
  release: ReleaseEvidenceResult,
): StandardEvidenceBundleV2 {
  return {
    deposit: {
      transactionHash: deposit.transactionHash,
      blockNumber: deposit.blockNumber.toString(),
      blockHash: deposit.blockHash,
      transactionIndex: deposit.transactionIndex,
      logIndex: deposit.logIndex,
      evidenceHash: deposit.evidenceHash,
      canonicalEvidence: deposit.canonicalEvidence,
      sources: [...deposit.sources],
    },
    release: {
      transactionHash: release.transactionHash,
      blockNumber: release.blockNumber.toString(),
      blockHash: release.blockHash,
      transactionIndex: release.transactionIndex,
      logIndex: release.logIndex,
      releaseSequence: release.releaseSequence.toString(),
      evidenceHash: release.evidenceHash,
      canonicalEvidence: release.canonicalEvidence,
      sources: [...release.sources],
    },
  };
}
