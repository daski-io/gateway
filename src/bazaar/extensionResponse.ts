import { keccak256, toBytes, type Hex } from "viem";
import { hasDuplicateJsonObjectKeys } from "../http/jsonDuplicateKeys.js";

export type BazaarIndexingStatus = "success" | "processing" | "rejected";

export interface ParsedBazaarExtensionResponse {
  headerHash: Hex | null;
  status: BazaarIndexingStatus | null;
  rejectedReasonHash: Hex | null;
}

export function parseBazaarExtensionResponse(
  header: string | null,
): ParsedBazaarExtensionResponse {
  if (header === null) {
    return { headerHash: null, status: null, rejectedReasonHash: null };
  }
  const headerHash = keccak256(toBytes(header));
  let decoded: unknown;
  try {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(header)) throw new Error("invalid base64");
    const bytes = Buffer.from(header, "base64");
    if (bytes.toString("base64") !== header) throw new Error("non-canonical base64");
    if (hasDuplicateJsonObjectKeys(bytes)) throw new Error("duplicate JSON keys");
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { headerHash, status: null, rejectedReasonHash: null };
  }
  const root = asRecord(decoded);
  const bazaar = asRecord(root?.bazaar);
  const status = bazaar?.status;
  if (status !== "success" && status !== "processing" && status !== "rejected") {
    return { headerHash, status: null, rejectedReasonHash: null };
  }
  const reason = bazaar?.rejectedReason;
  const rejectedReasonHash = typeof reason === "string" && reason.length <= 1_000
    ? keccak256(toBytes(reason))
    : null;
  return { headerHash, status, rejectedReasonHash };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
