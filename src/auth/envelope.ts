import { keccak256, toBytes, type Hex } from "viem";
import { randomUUID } from "node:crypto";

// EIP-712 A2A envelope authentication. Shared shape with daski-provider's
// src/core/auth/envelope.ts — must be kept in sync (the schema is on-chain
// in spirit: a divergence breaks signature recovery, not gracefully).

export const A2A_REQUEST_AUTHORIZATION_TYPES = {
  A2ARequestAuthorization: [
    { name: "buyerTokenId", type: "uint256" },
    { name: "skillId", type: "string" },
    { name: "paymentId", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "messageId", type: "string" },
    { name: "requestHash", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;

export const A2A_REQUEST_AUTHORIZATION_PRIMARY_TYPE = "A2ARequestAuthorization";

export const DASKI_AUTH_DOMAIN_NAME = "Daski";
export const DASKI_AUTH_DOMAIN_VERSION = "1";

export interface A2ARequestAuthorization {
  buyerTokenId: string;
  skillId: string;
  paymentId: string;
  chainId: number;
  messageId: string;
  requestHash: Hex;
  issuedAt: string;
}

export interface BuildEnvelopeInput {
  buyerTokenId: string;
  skillId: string;
  /** "0" if no payment is bound (e.g., open-free skill that nevertheless wants envelope auth). */
  paymentId: string;
  chainId: number;
  identityRegistryAddress: Hex;
  serviceArgs?: Record<string, unknown>;
  /** Optional override; auto-generated otherwise. */
  messageId?: string;
  /** Optional override; defaults to now. */
  issuedAt?: number;
}

export interface BuiltEnvelope {
  messageId: string;
  requestHash: Hex;
  issuedAt: string;
  authorization: A2ARequestAuthorization;
  eip712TypedData: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: Hex;
    };
    types: typeof A2A_REQUEST_AUTHORIZATION_TYPES;
    primaryType: typeof A2A_REQUEST_AUTHORIZATION_PRIMARY_TYPE;
    message: Record<string, unknown>;
  };
}

/**
 * Deterministic JSON serialization with recursively sorted object keys.
 * MUST match daski-provider's canonicalize/canonicalJsonStringify byte-for-byte
 * so signer and verifier produce the same hash.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(obj).sort()) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      throw new TypeError(`unsafe object key in signed JSON: ${key}`);
    }
    const v = obj[key];
    if (v === undefined) continue;
    sorted[key] = canonicalize(v);
  }
  return sorted;
}

export function computeRequestHash(serviceArgs: Record<string, unknown>): Hex {
  return keccak256(toBytes(canonicalJsonStringify(serviceArgs ?? {})));
}

/** Mint a fresh A2A messageId. UUID v4 is fine; the provider only insists
 *  it be unique per (buyerTokenId, messageId). */
function newMessageId(): string {
  return randomUUID();
}

/** Build the envelope typed-data the buyer's wallet signs. Returns the
 *  EIP-712 typed-data block plus the bookkeeping fields (messageId,
 *  requestHash, issuedAt, full authorization) the buyer threads through
 *  daski_submit_task alongside the signature. */
export function buildEnvelopeAuth(input: BuildEnvelopeInput): BuiltEnvelope {
  const messageId = input.messageId ?? newMessageId();
  const requestHash = computeRequestHash(input.serviceArgs ?? {});
  const issuedAt = (input.issuedAt ?? Math.floor(Date.now() / 1000)).toString();

  const authorization: A2ARequestAuthorization = {
    buyerTokenId: input.buyerTokenId,
    skillId: input.skillId,
    paymentId: input.paymentId,
    chainId: input.chainId,
    messageId,
    requestHash,
    issuedAt,
  };

  return {
    messageId,
    requestHash,
    issuedAt,
    authorization,
    eip712TypedData: {
      domain: {
        name: DASKI_AUTH_DOMAIN_NAME,
        version: DASKI_AUTH_DOMAIN_VERSION,
        chainId: input.chainId,
        verifyingContract: input.identityRegistryAddress,
      },
      types: A2A_REQUEST_AUTHORIZATION_TYPES,
      primaryType: A2A_REQUEST_AUTHORIZATION_PRIMARY_TYPE,
      // Wallet-friendly message: string-form bigints so the signature
      // prompt is human-legible. Viem typed-data signers coerce as needed.
      message: {
        buyerTokenId: authorization.buyerTokenId,
        skillId: authorization.skillId,
        paymentId: authorization.paymentId,
        chainId: authorization.chainId,
        messageId: authorization.messageId,
        requestHash: authorization.requestHash,
        issuedAt: authorization.issuedAt,
      },
    },
  };
}
