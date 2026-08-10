import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  parseSignature,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import { canonicalJsonStringify } from "../auth/envelope.js";
import { isHex32, isHexAddress } from "../util/evmValidation.js";
import type { ListingOfferV1 } from "./types.js";

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const HALF_SECP256K1_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const MAX_UINT256 = (1n << 256n) - 1n;

interface ParsedAuthorization {
  from: Hex;
  to: Hex;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface ParsedBazaarPayment {
  payload: PaymentPayload;
  authorization: ParsedAuthorization;
  authorizationDigest: Hex;
  authorizationKey: Hex;
  signatureDigest: Hex;
}

export type PaymentParseResult =
  | { ok: true; payment: ParsedBazaarPayment }
  | { ok: false; code: string };

export async function parseBazaarPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  offer: ListingOfferV1,
  nowSeconds: bigint,
): Promise<PaymentParseResult> {
  if (
    payload.x402Version !== 2 ||
    canonicalJsonStringify(payload.accepted) !== canonicalJsonStringify(requirements) ||
    payload.resource?.url !== offerResourceUrl(payload, offer)
  ) {
    return fail("payment_requirements_mismatch");
  }
  const exact = asRecord(payload.payload);
  if (!exact || !hasExactKeys(exact, ["authorization", "signature"])) {
    return fail("invalid_exact_payload");
  }
  const authorization = parseAuthorization(exact.authorization);
  const signature = exact.signature;
  if (!authorization || typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return fail("unsupported_payer_profile");
  }
  if (
    authorization.to.toLowerCase() !== offer.payTo.toLowerCase() ||
    authorization.value !== offer.grossAmount ||
    authorization.validAfter > nowSeconds ||
    authorization.validBefore <= nowSeconds + 10n ||
    authorization.validBefore > offer.validBefore
  ) {
    return fail("authorization_binding_mismatch");
  }
  const extra = asRecord(requirements.extra);
  if (typeof extra?.name !== "string" || typeof extra.version !== "string") {
    return fail("token_domain_missing");
  }
  const message = {
    ...authorization,
    from: authorization.from,
    to: authorization.to,
  };
  const typed = {
    domain: {
      name: extra.name,
      version: extra.version,
      chainId: offer.chainId,
      verifyingContract: offer.token,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message,
  };
  try {
    const parsedSignature = parseSignature(signature as Hex);
    if (BigInt(parsedSignature.s) > HALF_SECP256K1_N) return fail("non_canonical_signature");
    const signer = await recoverTypedDataAddress({ ...typed, signature: signature as Hex });
    if (signer.toLowerCase() !== authorization.from.toLowerCase()) {
      return fail("payer_signature_mismatch");
    }
  } catch {
    return fail("payer_signature_invalid");
  }
  const authorizationDigest = hashTypedData(typed);
  return {
    ok: true,
    payment: {
      payload,
      authorization,
      authorizationDigest,
      authorizationKey: keccak256(
        encodeAbiParameters(
          [
            { type: "uint256" },
            { type: "address" },
            { type: "address" },
            { type: "bytes32" },
          ],
          [offer.chainId, offer.token, authorization.from, authorization.nonce],
        ),
      ),
      signatureDigest: keccak256(signature as Hex),
    },
  };
}

function offerResourceUrl(payload: PaymentPayload, offer: ListingOfferV1): string {
  return payload.resource?.url &&
    keccak256(new TextEncoder().encode(payload.resource.url)) === offer.resourceHash
    ? payload.resource.url
    : "";
}

function parseAuthorization(value: unknown): ParsedAuthorization | null {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["from", "nonce", "to", "validAfter", "validBefore", "value"]) ||
    !isHexAddress(record.from) ||
    !isHexAddress(record.to) ||
    !isHex32(record.nonce) ||
    !isCanonicalDecimal(record.value) ||
    !isCanonicalDecimal(record.validAfter) ||
    !isCanonicalDecimal(record.validBefore)
  ) {
    return null;
  }
  return {
    from: record.from.toLowerCase() as Hex,
    to: record.to.toLowerCase() as Hex,
    nonce: record.nonce.toLowerCase() as Hex,
    value: BigInt(record.value),
    validAfter: BigInt(record.validAfter),
    validBefore: BigInt(record.validBefore),
  };
}

function isCanonicalDecimal(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 78 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) return false;
  return BigInt(value) <= MAX_UINT256;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function fail(code: string): PaymentParseResult {
  return { ok: false, code };
}
