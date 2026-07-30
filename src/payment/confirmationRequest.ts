import { encodeAbiParameters, parseAbiParameters } from "viem";
import type { Hex } from "../types.js";
import { isHex32, isHexAddress } from "../util/evmValidation.js";
import { hashCanonical } from "./requirementResponse.js";
import {
  CONFIRMATION_CODE,
  type ConfirmationLabel,
} from "./protocol.js";

const PAYLOAD_TYPES = parseAbiParameters(
  "uint256 paymentId, uint8 confirmation",
);

export interface ConfirmInput {
  confirmation: ConfirmationLabel;
  attester: Hex;
  easNonce: bigint;
  deadline: bigint;
  refUid: Hex | null;
  signature: { v: number; r: Hex; s: Hex };
}

export function parseConfirmInput(
  body: unknown,
): ConfirmInput | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "request body must be a JSON object" };
  }
  const value = body as Record<string, unknown>;
  if (
    value.confirmation !== "Confirmed" &&
    value.confirmation !== "NotConfirmed"
  ) {
    return { error: 'confirmation must be "Confirmed" or "NotConfirmed"' };
  }
  if (!isHexAddress(value.attester)) {
    return { error: "attester must be a 20-byte hex address" };
  }
  const deadline = unsignedBigInt(value.deadline);
  if (deadline == null || deadline === 0n) {
    return { error: "deadline must be a positive decimal integer" };
  }
  const easNonce = unsignedBigInt(value.easNonce);
  if (easNonce == null) {
    return { error: "easNonce must be an unsigned decimal integer" };
  }
  if (value.refUid !== undefined && !isHex32(value.refUid)) {
    return { error: "refUid, when provided, must be a 32-byte hex string" };
  }
  if (!value.signature || typeof value.signature !== "object") {
    return { error: "signature is required" };
  }
  const signature = value.signature as Record<string, unknown>;
  if (
    typeof signature.v !== "number" ||
    !Number.isInteger(signature.v) ||
    (signature.v !== 27 && signature.v !== 28) ||
    !isHex32(signature.r) ||
    !isHex32(signature.s)
  ) {
    return { error: "signature must contain uint8 v and 32-byte r/s" };
  }
  return {
    confirmation: value.confirmation,
    attester: value.attester.toLowerCase() as Hex,
    easNonce,
    deadline,
    refUid: (value.refUid as Hex | undefined) ?? null,
    signature: {
      v: signature.v,
      r: signature.r,
      s: signature.s,
    },
  };
}

export function confirmationPayload(
  paymentId: bigint,
  confirmation: ConfirmationLabel,
): Hex {
  return encodeAbiParameters(PAYLOAD_TYPES, [
    paymentId,
    CONFIRMATION_CODE[confirmation],
  ]);
}

export function confirmationRequestHash(input: {
  paymentId: bigint;
  confirmation: ConfirmationLabel;
  attester: Hex;
  recipient: Hex;
  easNonce: bigint;
  schema: Hex;
  refUid: Hex;
  data: Hex;
  deadline: bigint;
  signature: ConfirmInput["signature"];
}): Hex {
  return hashCanonical({
    paymentId: input.paymentId.toString(),
    confirmation: input.confirmation,
    attester: input.attester.toLowerCase(),
    recipient: input.recipient.toLowerCase(),
    easNonce: input.easNonce.toString(),
    schema: input.schema.toLowerCase(),
    refUid: input.refUid.toLowerCase(),
    data: input.data.toLowerCase(),
    deadline: input.deadline.toString(),
    signature: input.signature,
  });
}

function unsignedBigInt(value: unknown): bigint | null {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) ||
    (typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 0))
  ) {
    return null;
  }
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}
