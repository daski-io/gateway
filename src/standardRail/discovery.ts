import vm from "node:vm";
import { generateSync } from "json-schema-faker";
import { declareDiscoveryExtension, type BodyDiscoveryExtension } from "@x402/extensions/bazaar";
import type { PaymentPayload } from "@x402/core/types";
import type { Config } from "../config.js";
import { canonicalHash } from "./canonical.js";
import { assertSchema, compileClosedRequestSchema } from "./schema.js";
import { assertBoundedJsonValue, REQUEST_JSON_BUDGET } from "./jsonBounds.js";
import type { StandardListing } from "./types.js";

export const PURCHASE_RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    orderHandle: { type: "string" }, state: { type: "string" },
    receipt: { type: ["object", "null"] }, x402OfferReceipt: { type: ["object", "null"] },
  },
  required: ["orderHandle", "state", "receipt", "x402OfferReceipt"],
};
export const PURCHASE_RESPONSE_EXAMPLE = {
  orderHandle: "example-order-handle", state: "ATTEMPT_OPENED", receipt: null, x402OfferReceipt: null,
};
export const PURCHASE_GUIDANCE = "Read the outcome requirements before quoting. Submit the complete request, " +
  "receive a 402 challenge, and authorize only the returned amount. Recipe-bound outcomes require Daski's " +
  "nonce recipe or the gateway-pinned buyer CLI. Retry the identical request with PAYMENT-SIGNATURE, " +
  "or use the /purchase JSON adapter. A 202 response is an admitted asynchronous order, not completed " +
  "fulfillment. Reconcile the original payment identifier after uncertainty; never pay again blindly. " +
  "Examples are synthetic schema examples, not real customer details or guaranteed provider eligibility.";

export function outcomeRequestSchema(listing: Pick<StandardListing, "requestSchema" | "purchaseReadiness">): Record<string, unknown> {
  const properties = listing.requestSchema.properties as Record<string, unknown> | undefined;
  return {
    ...listing.requestSchema,
    properties: { ...properties, payerAddress: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", maxLength: 42,
      description: "Buyer wallet. Required for payer-bound DNS readiness; not provider input." } },
    ...(listing.purchaseReadiness === "payer_dns"
      ? { required: [...new Set([...(listing.requestSchema.required as string[] ?? []), "payerAddress"])] } : {}),
  };
}

function boundedGenerationSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...schema };
  if (copy.type === "string") {
    copy.maxLength = Math.min(typeof copy.maxLength === "number" ? copy.maxLength : 256, 256);
    if (typeof copy.minLength === "number" && copy.minLength > (copy.maxLength as number)) throw new Error("Example string exceeds budget");
  }
  if (copy.type === "array") {
    copy.maxItems = Math.min(typeof copy.maxItems === "number" ? copy.maxItems : 1, 16);
    if (typeof copy.minItems === "number" && copy.minItems > (copy.maxItems as number)) throw new Error("Example array exceeds budget");
    copy.items = boundedGenerationSchema(copy.items as Record<string, unknown>);
  }
  if (copy.type === "object" && copy.properties) {
    copy.properties = Object.fromEntries(Object.entries(copy.properties as Record<string, Record<string, unknown>>)
      .map(([key, child]) => [key, boundedGenerationSchema(child)]));
  }
  return copy;
}

const exampleCache = new Map<string, Record<string, unknown> | null>();
const generateExample = new vm.Script("generate(schema)", { filename: "daski-discovery-example.vm" });
/** Only published schemas enter this function; never pass an order or buyer request. */
export function discoveryExample(schema: Record<string, unknown>): Record<string, unknown> | null {
  const key = canonicalHash(schema);
  if (exampleCache.has(key)) return exampleCache.get(key)!;
  let result: Record<string, unknown> | null = null;
  try {
    const validate = compileClosedRequestSchema(schema);
    const value = generateExample.runInNewContext({ schema: boundedGenerationSchema(schema), generate: (input: Record<string, unknown>) => generateSync(input, {
      seed: 402, maxDepth: 24, maxDefaultItems: 1,
      optionalsProbability: 0, useDefaultValue: true, useExamplesValue: true,
      minDateTime: "2026-01-01T00:00:00.000Z", maxDateTime: "2026-01-01T00:00:00.000Z",
    }) }, { timeout: 100 });
    assertBoundedJsonValue(value, REQUEST_JSON_BUDGET, "discovery example");
    assertSchema(validate, value, "Request");
    if (JSON.stringify(value).length <= 16_384) result = value as Record<string, unknown>;
  } catch {
    // Unusual schemas must not break checkout. OpenAPI still publishes the
    // complete schema; the minimal Bazaar declaration links to that contract.
  }
  if (exampleCache.size >= 512) exampleCache.delete(exampleCache.keys().next().value!);
  exampleCache.set(key, result);
  return result;
}

export function legacyBazaarExtension(config: Pick<Config, "publicUrl">, listing: Pick<StandardListing, "requestSchema">) {
  const hash = canonicalHash(listing.requestSchema);
  return { info: { schemaRef: { hash, url: `${config.publicUrl}/public/v2/artifacts/${hash}` }, detailTool: "daski_get_outcome" } };
}

/** Compact protocol envelope only. Catalog schemas stay behind hash-bound references. */
export function compactBazaarExtension(config: Pick<Config, "publicUrl">, listing: Pick<StandardListing, "requestSchema">) {
  return {
    info: { input: { type: "http" as const, method: "POST" as const, bodyType: "json" as const, body: {} },
      ...legacyBazaarExtension(config, listing).info, openapi: `${config.publicUrl}/openapi.json` },
    // JSON Schema const already constrains the string type. Only the protocol
    // envelope is inline; the actual request schema remains hash-referenced.
    schema: { type: "object", properties: { input: { type: "object", properties: {
      type: { const: "http" }, method: { const: "POST" }, bodyType: { const: "json" }, body: { type: "object" },
    }, required: ["type", "method", "bodyType", "body"], additionalProperties: false } }, required: ["input"] },
  };
}

export function bazaarExtension(config: Pick<Config, "publicUrl">, listing: Pick<StandardListing, "requestSchema" | "purchaseReadiness">) {
  const inputSchema = outcomeRequestSchema(listing);
  const input = discoveryExample(inputSchema);
  const declared = declareDiscoveryExtension({ bodyType: "json", input: input ?? {},
    inputSchema: input ? inputSchema : { type: "object" },
    output: { example: PURCHASE_RESPONSE_EXAMPLE, schema: PURCHASE_RESPONSE_SCHEMA },
  }).bazaar as BodyDiscoveryExtension;
  return { ...declared, info: { ...declared.info, input: { ...declared.info.input, method: "POST" as const }, ...legacyBazaarExtension(config, listing).info,
    openapi: `${config.publicUrl}/openapi.json`,
    ...(input ? {} : { exampleUnavailable: true }),
  } };
}

/** Enrich only after payment admission; keep the stored authorization/hash intact. */
export function facilitatorDiscoveryPayment(config: Pick<Config, "publicUrl">, listing: StandardListing, payment: PaymentPayload): PaymentPayload {
  return { ...payment, extensions: { ...payment.extensions, bazaar: bazaarExtension(config, listing) } };
}

export interface DiscoveryOutcome {
  listing: StandardListing;
  description: string;
  pricing: Record<string, unknown>;
}

function decimalUsdc(amount: string): string {
  if (!/^[0-9]+$/.test(amount)) throw new Error("Invalid discovery USDC amount");
  const atomic = BigInt(amount);
  const fraction = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${atomic / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

function price(outcome: DiscoveryOutcome) {
  const offer = outcome.listing.offer.payload;
  if (offer.pricingMode === "fixed") return { mode: "fixed", currency: "USD", amount: decimalUsdc(offer.fixedGrossAmount) };
  const usdc = outcome.pricing.USDC as Record<string, unknown> | undefined;
  return { mode: "dynamic", currency: "USD",
    ...(typeof usdc?.min_amount === "string" ? { min: decimalUsdc(usdc.min_amount) } : {}),
    ...(typeof usdc?.max_amount === "string" ? { max: decimalUsdc(usdc.max_amount) } : {}),
  };
}

export function discoveryOpenApi(args: { publicUrl: string; docsUrl: string; version: string; outcomes: DiscoveryOutcome[] }) {
  const paths: Record<string, unknown> = {};
  for (const outcome of args.outcomes) {
    const { listing } = outcome;
    const resource = new URL(listing.commitment.payload.absoluteResourceUri);
    if (resource.origin !== new URL(args.publicUrl).origin || resource.search || resource.hash) {
      throw new Error("Discovery resource is outside the gateway origin");
    }
    const schema = outcomeRequestSchema(listing);
    const example = discoveryExample(schema);
    const content = { "application/json": { schema: PURCHASE_RESPONSE_SCHEMA, example: PURCHASE_RESPONSE_EXAMPLE } };
    paths[resource.pathname] = { post: {
      operationId: `purchase_${listing.commitment.payload.providerAgentId}_${listing.commitment.payload.outcomeId}`,
      summary: listing.presentation.skillName,
      description: `${outcome.description} ${PURCHASE_GUIDANCE}`,
      tags: [listing.presentation.serviceName],
      "x-payment-info": { protocols: [{ x402: {} }], price: price(outcome) },
      "x-daski-binding-profile": listing.commitment.payload.bindingProfile,
      "x-daski-requirements-url": `${resource.href}/requirements`,
      "x-daski-purchase-readiness": listing.purchaseReadiness,
      requestBody: { required: true, content: { "application/json": { schema, ...(example ? { example } : {}) } } },
      responses: {
        "200": { description: "Order dispatched or fulfilled. Inspect state and use authorized order lifecycle calls.", content },
        "202": { description: "Order admitted; settlement or fulfillment is pending.", content },
        "402": { description: "Payment required. Sign the returned authorization and retry the identical request.",
          headers: { "PAYMENT-REQUIRED": { description: "Base64url x402 v2 challenge; the JSON body is complete if the header is omitted for size.", schema: { type: "string" } } },
          content: { "application/json": { schema: { type: "object", required: ["x402Version", "resource", "accepts", "extensions"],
            properties: { x402Version: { const: 2 }, resource: { type: "object" }, accepts: { type: "array", items: { type: "object" } }, extensions: { type: "object" } } } } } },
        "400": { description: "Invalid or incomplete request. Consult the requirements endpoint." },
        "409": { description: "Provider eligibility, availability, readiness, or purchase state prevents this request." },
        "429": { description: "Rate limited; honor Retry-After." },
        "503": { description: "Temporary upstream or marketplace unavailability." },
      },
    } };
  }
  paths["/public/v2/outcomes"] = { get: { operationId: "listOutcomes", summary: "Browse current purchasable outcomes", security: [],
    responses: { "200": { description: "Public outcome catalog", content: { "application/json": { schema: { type: "object" } } } } } } };
  return { openapi: "3.1.0", info: { title: "Daski", version: args.version,
    description: "Discover, buy, and manage real-world business services through Daski.", "x-guidance": PURCHASE_GUIDANCE },
    servers: [{ url: args.publicUrl }], externalDocs: { url: `${args.docsUrl}/skills/setup.md` }, paths };
}
