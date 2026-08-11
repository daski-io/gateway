import { isHex32 } from "../util/evmValidation.js";
import type { BazaarLeaseGuard } from "./lease.js";
import type {
  BazaarCompatibilityWiring,
  BazaarOrder,
  BazaarSettlementObservationPolicy,
  BazaarSettlementObservationResult,
} from "./types.js";

const MAX_OBSERVATION_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const MAX_RETRY_DELAY_SECONDS = 60 * 60;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

export function validateSettlementObservationPolicy(
  policy: BazaarSettlementObservationPolicy,
): void {
  if (
    !policy || typeof policy !== "object" ||
    !Number.isSafeInteger(policy.finalityWindowSeconds) ||
    policy.finalityWindowSeconds < 60 ||
    policy.finalityWindowSeconds > MAX_OBSERVATION_WINDOW_SECONDS ||
    !Number.isSafeInteger(policy.retryDelaySeconds) ||
    policy.retryDelaySeconds < 5 ||
    policy.retryDelaySeconds > MAX_RETRY_DELAY_SECONDS
  ) throw new Error("Bazaar settlement-observation policy is invalid");
}

export function requiredObservedThrough(
  order: BazaarOrder,
  policy: BazaarSettlementObservationPolicy,
): bigint {
  return order.authorizationValidBefore + BigInt(policy.finalityWindowSeconds);
}

export async function observeBazaarSettlement(input: {
  order: BazaarOrder;
  wiring: BazaarCompatibilityWiring;
  lease: BazaarLeaseGuard;
}): Promise<BazaarSettlementObservationResult> {
  const { order, wiring, lease } = input;
  const requiredThrough = requiredObservedThrough(
    order,
    wiring.settlementObservationPolicy,
  );
  const now = BigInt(Math.floor((wiring.now?.() ?? new Date()).getTime() / 1000));
  if (now < requiredThrough) return { kind: "pending" };
  let response: unknown;
  try {
    lease.assertOwned();
    response = await wiring.settlementObserver.observe({
      orderRecordId: order.orderRecordId,
      authorizationDigest: order.authorizationDigest,
      chainId: order.chainId,
      token: order.token,
      payer: order.payer,
      nonce: order.nonce,
      payTo: order.payTo,
      grossAmount: order.grossAmount,
      authorizationValidBefore: order.authorizationValidBefore,
      requiredObservedThrough: requiredThrough,
    }, lease.signal);
    lease.assertOwned();
  } catch {
    return { kind: "pending" };
  }
  const result = parseObservationResult(response);
  if (!result) return { kind: "pending" };
  if (result.kind === "pending") return result;
  if (
    result.observedThrough < requiredThrough || result.observedThrough > now ||
    !isNonzeroHex32(result.evidenceHash)
  ) return { kind: "pending" };
  if (result.kind === "no_transfer") return result;
  return validMatchingTransfer(result) ? result : { kind: "pending" };
}

function validMatchingTransfer(
  result: Extract<BazaarSettlementObservationResult, { kind: "matching_transfer" }>,
): boolean {
  const indexes = [
    result.transactionIndex,
    result.authorizationLogIndex,
    result.transferLogIndex,
  ];
  return isNonzeroHex32(result.transaction) &&
    isNonzeroHex32(result.blockHash) &&
    result.finalized === true &&
    result.authorizationUsedEventCount === 1 &&
    result.matchingTransferEventCount === 1 &&
    indexes.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    result.authorizationLogIndex !== result.transferLogIndex;
}

function isNonzeroHex32(value: unknown): boolean {
  return isHex32(value) && value.toLowerCase() !== ZERO_BYTES32;
}

function parseObservationResult(
  value: unknown,
): BazaarSettlementObservationResult | null {
  if (!isRecord(value)) return null;
  if (value.kind === "pending" && hasExactKeys(value, ["kind"])) {
    return { kind: "pending" };
  }
  if (
    value.kind === "no_transfer" &&
    hasExactKeys(value, ["kind", "observedThrough", "evidenceHash"]) &&
    typeof value.observedThrough === "bigint" &&
    typeof value.evidenceHash === "string"
  ) return value as Extract<BazaarSettlementObservationResult, { kind: "no_transfer" }>;
  const matchingKeys = [
    "kind", "observedThrough", "evidenceHash", "transaction", "blockHash",
    "transactionIndex", "authorizationLogIndex", "transferLogIndex",
    "finalized", "authorizationUsedEventCount", "matchingTransferEventCount",
  ];
  if (
    value.kind === "matching_transfer" && hasExactKeys(value, matchingKeys) &&
    typeof value.observedThrough === "bigint" &&
    [value.evidenceHash, value.transaction, value.blockHash]
      .every((field) => typeof field === "string") &&
    [value.transactionIndex, value.authorizationLogIndex, value.transferLogIndex]
      .every((field) => typeof field === "number") &&
    value.finalized === true && value.authorizationUsedEventCount === 1 &&
    value.matchingTransferEventCount === 1
  ) return value as Extract<
    BazaarSettlementObservationResult,
    { kind: "matching_transfer" }
  >;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
