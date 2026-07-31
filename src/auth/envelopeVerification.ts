import { recoverTypedDataAddress, type Hex } from "viem";
import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import { walletControlsAgent } from "../identity/control.js";
import {
  A2A_REQUEST_AUTHORIZATION_PRIMARY_TYPE,
  A2A_REQUEST_AUTHORIZATION_TYPES,
  DASKI_AUTH_DOMAIN_NAME,
  DASKI_AUTH_DOMAIN_VERSION,
  type A2ARequestAuthorization,
} from "./envelope.js";

interface EnvelopeAuth {
  signature: Hex;
  authorization: A2ARequestAuthorization;
}

export interface ExpectedEnvelopeBinding {
  buyerTokenId: bigint;
  skillId: string;
  paymentId: string;
  chainId: number;
  messageId: string;
  requestHash: Hex;
}

export type EnvelopeVerificationResult =
  | { ok: true }
  | { ok: false; code: string };

export async function verifyEnvelopeAuth(
  config: Config,
  reader: ChainReader,
  value: unknown,
  expected: ExpectedEnvelopeBinding,
): Promise<EnvelopeVerificationResult> {
  const parsed = parseEnvelopeAuth(value);
  if (!parsed) return { ok: false, code: "INVALID_SHAPE" };
  const { authorization } = parsed;
  if (
    authorization.buyerTokenId !== expected.buyerTokenId.toString() ||
    authorization.skillId !== expected.skillId ||
    authorization.paymentId !== expected.paymentId ||
    authorization.chainId !== expected.chainId ||
    authorization.messageId !== expected.messageId ||
    authorization.requestHash.toLowerCase() !==
      expected.requestHash.toLowerCase()
  ) {
    return { ok: false, code: "FIELD_MISMATCH" };
  }
  if (authorization.chainId !== config.chainId) {
    return { ok: false, code: "CHAIN_MISMATCH" };
  }

  try {
    const signer = await recoverTypedDataAddress({
      domain: {
        name: DASKI_AUTH_DOMAIN_NAME,
        version: DASKI_AUTH_DOMAIN_VERSION,
        chainId: config.chainId,
        verifyingContract: config.identityRegistryAddress,
      },
      types: A2A_REQUEST_AUTHORIZATION_TYPES,
      primaryType: A2A_REQUEST_AUTHORIZATION_PRIMARY_TYPE,
      message: {
        ...authorization,
        buyerTokenId: BigInt(authorization.buyerTokenId),
        paymentId: BigInt(authorization.paymentId),
        chainId: BigInt(authorization.chainId),
        issuedAt: BigInt(authorization.issuedAt),
      },
      signature: parsed.signature,
    });
    if (!(await walletControlsAgent(reader, expected.buyerTokenId, signer))) {
      return { ok: false, code: "WRONG_SIGNER" };
    }
  } catch {
    return { ok: false, code: "BAD_SIGNATURE" };
  }
  return { ok: true };
}

function parseEnvelopeAuth(value: unknown): EnvelopeAuth | null {
  if (!isRecord(value) || !hasExactKeys(value, ["signature", "authorization"])) {
    return null;
  }
  if (!isHex(value.signature, 65) || !isRecord(value.authorization)) return null;
  const authorization = value.authorization;
  if (
    !hasExactKeys(authorization, [
      "buyerTokenId",
      "skillId",
      "paymentId",
      "chainId",
      "messageId",
      "requestHash",
      "issuedAt",
    ]) ||
    !isDecimal(authorization.buyerTokenId) ||
    typeof authorization.skillId !== "string" ||
    authorization.skillId.length === 0 ||
    !isDecimal(authorization.paymentId) ||
    !Number.isSafeInteger(authorization.chainId) ||
    typeof authorization.messageId !== "string" ||
    authorization.messageId.length === 0 ||
    authorization.messageId.length > 256 ||
    !isHex(authorization.requestHash, 32) ||
    !isDecimal(authorization.issuedAt)
  ) {
    return null;
  }
  return value as unknown as EnvelopeAuth;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key)
  );
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function isHex(value: unknown, bytes: number): value is Hex {
  return (
    typeof value === "string" &&
    new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)
  );
}
