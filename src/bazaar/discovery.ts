import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
  validateDiscoveryExtension,
  validateDiscoveryExtensionSpec,
  type DiscoveryExtension,
} from "@x402/extensions/bazaar";
import type { BazaarListing } from "./types.js";

const EXAMPLE_HANDLE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function buildBazaarDiscovery(
  listing: BazaarListing,
): Record<string, unknown> {
  const declared = declareDiscoveryExtension({
    bodyType: "json",
    input: {},
    inputSchema: listing.requestSchema,
    output: {
      example: {
        orderHandle: EXAMPLE_HANDLE,
        lifecycle: {
          challengeUrl: `${origin(listing.resourceUrl)}/x402/v1/orders/${EXAMPLE_HANDLE}/challenge`,
          redeemUrl: `${origin(listing.resourceUrl)}/x402/v1/orders/${EXAMPLE_HANDLE}/actions`,
        },
      },
      schema: listing.responseSchema,
    },
  }).bazaar;
  if (!declared || !bazaarResourceServerExtension.enrichDeclaration) {
    throw new Error("installed x402 Bazaar extension cannot enrich discovery");
  }
  const enriched = bazaarResourceServerExtension.enrichDeclaration(declared, {
    method: "POST",
    routePattern: listing.routePath,
    adapter: { getPath: () => listing.routePath },
  }) as DiscoveryExtension;
  const schemaResult = validateDiscoveryExtension(enriched);
  const specResult = validateDiscoveryExtensionSpec(
    enriched as unknown as Record<string, unknown>,
  );
  if (!schemaResult.valid || !specResult.valid) {
    throw new Error(
      `invalid Bazaar discovery declaration: ${[
        ...(schemaResult.errors ?? []),
        ...(specResult.errors ?? []),
      ].join("; ")}`,
    );
  }
  return { bazaar: enriched };
}

function origin(resourceUrl: string): string {
  return new URL(resourceUrl).origin;
}
