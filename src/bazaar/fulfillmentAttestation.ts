import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  parseSignature,
  recoverTypedDataAddress,
  toBytes,
  type Hex,
} from "viem";
import { isHex32 } from "../util/evmValidation.js";
import type { BazaarLeaseGuard } from "./lease.js";
import type { BazaarFulfillmentWorkItem } from "./fulfillmentLeaseStore.js";
import type {
  BazaarCompatibilityWiring,
  BazaarFulfillmentAttestationMessage,
  BazaarFulfillmentOutcome,
} from "./types.js";

export const BAZAAR_FULFILLMENT_ATTESTATION_TYPES = {
  DaskiBazaarFulfillmentAttestation: [
    { name: "orderRecordId", type: "bytes32" },
    { name: "taskIdHash", type: "bytes32" },
    { name: "providerAgentId", type: "uint256" },
    { name: "listingCommitment", type: "bytes32" },
    { name: "authorizationDigest", type: "bytes32" },
    { name: "outcomeId", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "settlementTransaction", type: "bytes32" },
    { name: "outcomeHash", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "evidenceId", type: "bytes32" },
  ],
} as const;

const EVIDENCE_ID_DOMAIN = keccak256(
  toBytes("DASKI_BAZAAR_FULFILLMENT_EVIDENCE_V1"),
);
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const HALF_SECP256K1_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const OUTCOME_HASHES = Object.fromEntries([
  "FULFILLED",
  "PROVIDER_COMPLIANCE_FAILURE",
  "PROVIDER_FULFILLMENT_FAILURE",
].map((outcome) => [outcome, keccak256(toBytes(outcome))])) as Record<
  BazaarFulfillmentOutcome,
  Hex
>;

export interface VerifiedBazaarFulfillmentAttestation {
  outcome: BazaarFulfillmentOutcome;
  evidenceHash: Hex;
  evidenceId: Hex;
  attestationDigest: Hex;
  signature: Hex;
}

export function computeBazaarFulfillmentEvidenceId(input: {
  orderRecordId: Hex;
  taskIdHash: Hex;
  outcome: BazaarFulfillmentOutcome;
  evidenceHash: Hex;
}): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" },
    ],
    [
      EVIDENCE_ID_DOMAIN, input.orderRecordId, input.taskIdHash,
      OUTCOME_HASHES[input.outcome], input.evidenceHash,
    ],
  ));
}

export async function observeBazaarFulfillment(input: {
  work: BazaarFulfillmentWorkItem;
  wiring: BazaarCompatibilityWiring;
  lease: BazaarLeaseGuard;
}): Promise<VerifiedBazaarFulfillmentAttestation | "pending"> {
  let response: unknown;
  try {
    input.lease.assertOwned();
    response = await input.wiring.fulfillmentObserver.observe({
      orderRecordId: input.work.orderRecordId,
      taskId: input.work.taskId,
      taskIdHash: input.work.taskIdHash,
      providerAgentId: input.work.providerAgentId,
      listingCommitment: input.work.listingCommitment,
      authorizationDigest: input.work.authorizationDigest,
      outcomeId: input.work.outcomeId,
      requestHash: input.work.requestHash,
      settlementTransaction: input.work.settlementTransaction,
      chainId: input.work.chainId,
      payTo: input.work.payTo,
    }, input.lease.signal);
    input.lease.assertOwned();
  } catch {
    return "pending";
  }
  const attestation = parseAttestation(response);
  if (!attestation || attestation === "pending") return "pending";
  return verifyAttestation(input.work, attestation);
}

async function verifyAttestation(
  work: BazaarFulfillmentWorkItem,
  attestation: { message: BazaarFulfillmentAttestationMessage; signature: Hex },
): Promise<VerifiedBazaarFulfillmentAttestation | "pending"> {
  const outcome = outcomeFromHash(attestation.message.outcomeHash);
  if (!outcome || !messageMatches(work, attestation.message, outcome)) return "pending";
  const typed = typedData(work, attestation.message);
  try {
    if (BigInt(parseSignature(attestation.signature).s) > HALF_SECP256K1_N) {
      return "pending";
    }
    const signer = await recoverTypedDataAddress({
      ...typed,
      signature: attestation.signature,
    });
    if (signer.toLowerCase() !== work.fulfillmentSigner.toLowerCase()) return "pending";
    return {
      outcome,
      evidenceHash: attestation.message.evidenceHash,
      evidenceId: attestation.message.evidenceId,
      attestationDigest: hashTypedData(typed),
      signature: attestation.signature,
    };
  } catch {
    return "pending";
  }
}

function typedData(
  work: BazaarFulfillmentWorkItem,
  message: BazaarFulfillmentAttestationMessage,
) {
  return {
    domain: {
      name: "Daski Bazaar Fulfillment Attestation",
      version: "1",
      chainId: work.chainId,
      verifyingContract: work.payTo,
    },
    types: BAZAAR_FULFILLMENT_ATTESTATION_TYPES,
    primaryType: "DaskiBazaarFulfillmentAttestation" as const,
    message: { ...message, providerAgentId: work.providerAgentId },
  };
}

function messageMatches(
  work: BazaarFulfillmentWorkItem,
  message: BazaarFulfillmentAttestationMessage,
  outcome: BazaarFulfillmentOutcome,
): boolean {
  return message.orderRecordId.toLowerCase() === work.orderRecordId.toLowerCase() &&
    message.taskIdHash.toLowerCase() === work.taskIdHash.toLowerCase() &&
    message.providerAgentId === work.providerAgentId.toString() &&
    message.listingCommitment.toLowerCase() === work.listingCommitment.toLowerCase() &&
    message.authorizationDigest.toLowerCase() === work.authorizationDigest.toLowerCase() &&
    message.outcomeId.toLowerCase() === work.outcomeId.toLowerCase() &&
    message.requestHash.toLowerCase() === work.requestHash.toLowerCase() &&
    message.settlementTransaction.toLowerCase() ===
      work.settlementTransaction.toLowerCase() &&
    message.outcomeHash.toLowerCase() === OUTCOME_HASHES[outcome].toLowerCase() &&
    isNonzeroHex32(message.evidenceHash) &&
    message.evidenceId.toLowerCase() === computeBazaarFulfillmentEvidenceId({
      orderRecordId: work.orderRecordId,
      taskIdHash: work.taskIdHash,
      outcome,
      evidenceHash: message.evidenceHash,
    }).toLowerCase();
}

function parseAttestation(value: unknown):
  | "pending"
  | { message: BazaarFulfillmentAttestationMessage; signature: Hex }
  | null {
  if (!isRecord(value)) return null;
  if (value.kind === "pending" && hasExactKeys(value, ["kind"])) return "pending";
  if (
    value.kind !== "attested" ||
    !hasExactKeys(value, ["kind", "message", "signature"]) ||
    !isRecord(value.message) ||
    !hasExactKeys(value.message, [
      "orderRecordId", "taskIdHash", "providerAgentId", "listingCommitment",
      "authorizationDigest", "outcomeId", "requestHash",
      "settlementTransaction", "outcomeHash", "evidenceHash", "evidenceId",
    ]) ||
    !Object.values(value.message).every((field) => typeof field === "string") ||
    !/^0x[0-9a-fA-F]{130}$/.test(String(value.signature))
  ) return null;
  return {
    message: value.message as unknown as BazaarFulfillmentAttestationMessage,
    signature: value.signature as Hex,
  };
}

function outcomeFromHash(hash: Hex): BazaarFulfillmentOutcome | null {
  return (Object.entries(OUTCOME_HASHES).find(([, value]) =>
    value.toLowerCase() === hash.toLowerCase())?.[0] as BazaarFulfillmentOutcome) ?? null;
}

function isNonzeroHex32(value: unknown): value is Hex {
  return isHex32(value) && value.toLowerCase() !== ZERO_BYTES32;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
