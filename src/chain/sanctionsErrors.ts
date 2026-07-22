import { decodeErrorResult, toFunctionSelector } from "viem";
import type { Hex } from "../types.js";
import { isHexAddress } from "../util/evmValidation.js";

export const sanctionsErrorAbi = [
  {
    type: "error",
    name: "SanctionedAddress",
    inputs: [{ name: "account", type: "address" }],
  },
  {
    type: "error",
    name: "SanctionsOracleUnavailable",
    inputs: [{ name: "oracle", type: "address" }],
  },
] as const;

export const sanctionsGuardAbi = [
  {
    type: "function",
    name: "sanctionsOracle",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

export const sanctionsOracleAbi = [
  {
    type: "function",
    name: "isSanctioned",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

export type SettlementScreeningFailure =
  | {
      code: "SANCTIONS_ADDRESS_REJECTED";
      retryable: false;
      selector: Hex;
      account: Hex;
    }
  | {
      code: "SANCTIONS_SCREENING_UNAVAILABLE";
      retryable: true;
      selector: Hex;
      oracle: Hex;
    };

export type ScreeningDetectionSource =
  | "simulation"
  | "submission"
  | "receipt_replay";

export class SettlementScreeningError extends Error {
  constructor(
    readonly failure: SettlementScreeningFailure,
    readonly detectionSource: ScreeningDetectionSource,
    readonly transactionHash: Hex | null = null,
  ) {
    super(failure.code);
    this.name = "SettlementScreeningError";
  }
}

const REJECTED_SELECTOR = toFunctionSelector("SanctionedAddress(address)");
const UNAVAILABLE_SELECTOR = toFunctionSelector(
  "SanctionsOracleUnavailable(address)",
);

export function classifySettlementScreeningFailure(
  error: unknown,
): SettlementScreeningFailure | null {
  for (const data of collectHexData(error)) {
    const failure = decodeFailure(data);
    if (failure) return failure;
  }
  return null;
}

export function screeningFailureAddress(
  failure: SettlementScreeningFailure,
): { kind: "account" | "oracle"; address: Hex } {
  return failure.code === "SANCTIONS_ADDRESS_REJECTED"
    ? { kind: "account", address: failure.account }
    : { kind: "oracle", address: failure.oracle };
}

function decodeFailure(data: Hex): SettlementScreeningFailure | null {
  if (data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  if (selector !== REJECTED_SELECTOR && selector !== UNAVAILABLE_SELECTOR) {
    return null;
  }
  try {
    const decoded = decodeErrorResult({ abi: sanctionsErrorAbi, data });
    const args = Array.from(decoded.args ?? []);
    if (args.length !== 1 || !isHexAddress(args[0])) return null;
    const address = args[0].toLowerCase() as Hex;
    return decoded.errorName === "SanctionedAddress"
      ? {
          code: "SANCTIONS_ADDRESS_REJECTED",
          retryable: false,
          selector,
          account: address,
        }
      : {
          code: "SANCTIONS_SCREENING_UNAVAILABLE",
          retryable: true,
          selector,
          oracle: address,
        };
  } catch {
    return null;
  }
}

function collectHexData(root: unknown): Hex[] {
  const found: Hex[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof value === "string") {
      if (/^0x[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
        found.push(value as Hex);
      }
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of ["data", "raw", "cause", "error", "details"]) {
      visit((value as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(root, 0);
  return found;
}
