import type { Config } from "../config.js";
import type { ExactEvmAuthorization, Hex } from "../types.js";
import { decodeBase64JsonObject, isHex32, isHexAddress } from "./protocol.js";
import type { SkillOffer } from "./skillOffer.js";

export interface BazaarPayment {
  version: 2;
  signature: Hex;
  authorization: ExactEvmAuthorization;
  raw: Record<string, unknown>;
}

export function decodeBazaarPayment(header: string): BazaarPayment | null {
  const decoded = decodeBase64JsonObject(header);
  if (!decoded) return null;
  const version =
    typeof decoded.x402Version === "number"
      ? decoded.x402Version
      : Number.NaN;
  if (version !== 2) return null;

  const payload = decoded.payload;
  if (!payload || typeof payload !== "object") return null;
  const signature = (payload as Record<string, unknown>).signature;
  const authorization = (payload as Record<string, unknown>).authorization;
  if (
    typeof signature !== "string" ||
    !authorization ||
    typeof authorization !== "object"
  ) {
    return null;
  }
  const fields = authorization as Record<string, unknown>;
  if (
    !isHexAddress(fields.from) ||
    !isHexAddress(fields.to) ||
    !isHex32(fields.nonce) ||
    typeof fields.value !== "string" ||
    typeof fields.validAfter !== "string" ||
    typeof fields.validBefore !== "string"
  ) {
    return null;
  }
  return {
    version,
    signature: signature as Hex,
    authorization: {
      from: fields.from,
      to: fields.to,
      value: fields.value,
      validAfter: fields.validAfter,
      validBefore: fields.validBefore,
      nonce: fields.nonce,
    },
    raw: decoded,
  };
}

export function acceptedProviderQuote(payment: BazaarPayment): unknown {
  const accepted = payment.raw.accepted;
  if (!accepted || typeof accepted !== "object") return undefined;
  const extra = (accepted as Record<string, unknown>).extra;
  if (!extra || typeof extra !== "object") return undefined;
  const daski = (extra as Record<string, unknown>).daski;
  if (!daski || typeof daski !== "object") return undefined;
  return (daski as Record<string, unknown>).providerQuote;
}

export function buildFacilitatorRequirements(
  offer: SkillOffer,
  amount: bigint,
  config: Config,
  resourceUrl: string,
  maxTimeoutSeconds: number,
): Record<string, unknown> {
  return {
    scheme: "exact",
    network: `eip155:${config.chainId}`,
    amount: amount.toString(),
    asset: config.usdcAddress,
    payTo: config.paymentRouterAddress,
    maxTimeoutSeconds,
    extra: { name: config.usdcName, version: config.usdcVersion },
  };
}

export function buildForwardedPayload(
  payment: BazaarPayment,
  offer: SkillOffer,
  resourceUrl: string,
): Record<string, unknown> {
  const forwarded: Record<string, unknown> = { ...payment.raw };
  if (forwarded.resource === undefined) {
    forwarded.resource = {
      url: resourceUrl,
      description: offer.description,
      mimeType: "application/json",
    };
  }
  return forwarded;
}
