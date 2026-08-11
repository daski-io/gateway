import { canonicalJsonStringify } from "../auth/envelope.js";
import type { BazaarListing } from "./types.js";

const STOCK_FIXED_REQUEST_SCHEMA_JSON = canonicalJsonStringify({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});

const STOCK_FIXED_RESPONSE_SCHEMA_JSON = canonicalJsonStringify({
  type: "object",
  properties: {
    orderHandle: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
    lifecycle: {
      type: "object",
      properties: {
        challengeUrl: { type: "string" },
        redeemUrl: { type: "string" },
      },
      required: ["challengeUrl", "redeemUrl"],
      additionalProperties: false,
    },
  },
  required: ["orderHandle", "lifecycle"],
  additionalProperties: false,
});

export function validateStockFixedDiscoverySchemas(
  listing: Pick<BazaarListing, "requestSchema" | "responseSchema">,
): void {
  if (
    canonicalJsonStringify(listing.requestSchema) !==
      STOCK_FIXED_REQUEST_SCHEMA_JSON ||
    canonicalJsonStringify(listing.responseSchema) !==
      STOCK_FIXED_RESPONSE_SCHEMA_JSON
  ) {
    throw new Error("Bazaar listing must use the canonical stock-fixed schemas");
  }
}
