import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import type { Network } from "@x402/core/types";
import { canonicalJsonStringify } from "../auth/envelope.js";
import { buildBazaarDiscovery } from "./discovery.js";
import type { BazaarListing } from "./types.js";

const PAYMENT_TIMEOUT_SECONDS = 5 * 60;

export interface BazaarPaymentDeclaration {
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
}

export function buildPaymentDeclaration(
  listing: BazaarListing,
  nowSeconds: bigint,
): BazaarPaymentDeclaration {
  const offer = listing.offer.message;
  const remaining = offer.validBefore - nowSeconds;
  if (remaining <= BigInt(PAYMENT_TIMEOUT_SECONDS + 10)) {
    throw new Error("Bazaar listing offer is too close to expiry");
  }
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: `eip155:${offer.chainId}` as Network,
    asset: offer.token,
    amount: offer.grossAmount.toString(),
    payTo: offer.payTo,
    maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
    extra: {
      name: listing.assetName,
      version: listing.assetVersion,
      assetTransferMethod: "eip3009",
    },
  };
  return {
    requirements,
    paymentRequired: {
      x402Version: 2,
      resource: {
        url: listing.resourceUrl,
        description: listing.description,
        mimeType: "application/json",
        serviceName: listing.sellerName,
        tags: ["Daski", "paid outcome"],
      },
      accepts: [requirements],
      extensions: buildBazaarDiscovery(listing),
    },
  };
}

export function bindServerPaymentPayload(
  decoded: PaymentPayload,
  declaration: BazaarPaymentDeclaration,
): PaymentPayload | null {
  try {
    if (
      !hasExactKeys(decoded as unknown as Record<string, unknown>, [
        "accepted", "extensions", "payload", "resource", "x402Version",
      ]) ||
      decoded.x402Version !== 2 ||
      canonicalJsonStringify(decoded.accepted) !==
        canonicalJsonStringify(declaration.requirements) ||
      canonicalJsonStringify(decoded.resource) !==
        canonicalJsonStringify(declaration.paymentRequired.resource) ||
      canonicalJsonStringify(decoded.extensions) !==
        canonicalJsonStringify(declaration.paymentRequired.extensions)
    ) return null;
  } catch {
    return null;
  }
  return decoded;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
