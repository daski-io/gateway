import { describe, expect, it } from "vitest";
import express from "express";
import { once } from "node:events";
import { validateDiscoveryExtension, validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";
import type { PaymentPayload } from "@x402/core/types";
import { type DiscoveryOutcome, bazaarExtension, compactBazaarExtension, discoveryExample, discoveryOpenApi, facilitatorDiscoveryPayment, outcomeRequestSchema } from "../src/standardRail/discovery.js";
import { facilitatorDiscoveryStatus } from "../src/standardRail/facilitator.js";
import { createStandardRailRouter } from "../src/standardRail/routes.js";
import type { StandardListing } from "../src/standardRail/types.js";

const listing = {
  presentation: { serviceName: "Example Services", skillName: "Reserve a service" },
  commitment: { payload: { providerAgentId: "42", outcomeId: "reserve-service", absoluteResourceUri: "https://gateway.example/outcomes/42/reserve-service", bindingProfile: "recipe-bound-v2" } },
  offer: { payload: { pricingMode: "fixed", fixedGrossAmount: "9990000", skillId: "reserve-service" } },
  requestSchema: { type: "object", additionalProperties: false, required: ["name", "quantity"], properties: {
    name: { type: "string", minLength: 3, maxLength: 20 }, quantity: { type: "integer", minimum: 1, maximum: 5 },
  } },
  purchaseReadiness: null,
} as unknown as StandardListing;
const config = { publicUrl: "https://gateway.example" };
const outcome: DiscoveryOutcome = { listing, description: "Reserve a service with asynchronous delivery.", pricing: { USDC: { fixed_amount: "9990000" } } };
const api = (outcomes = [outcome]) => discoveryOpenApi({ ...config, docsUrl: "https://website.example", version: "test", outcomes });

describe("public x402 discovery", () => {
  it("passes the upstream Bazaar validators with complete request and asynchronous response schemas", () => {
    const extension = bazaarExtension(config, listing);
    expect(validateDiscoveryExtensionSpec(extension)).toEqual({ valid: true });
    expect(validateDiscoveryExtension(extension)).toEqual({ valid: true });
    expect(extension.info.input).toMatchObject({ type: "http", method: "POST", bodyType: "json" });
    expect(extension.schema.properties.input.properties.body).toEqual(outcomeRequestSchema(listing));
    expect(extension.info.output?.example).toMatchObject({ state: "ATTEMPT_OPENED", receipt: null });
    expect(extension.info).not.toHaveProperty("exampleUnavailable");
  });

  it("uses deterministic schema-derived examples, supports payer readiness and preserves the published schema", () => {
    const schema = outcomeRequestSchema({ ...listing, purchaseReadiness: "payer_dns" });
    expect(schema.required).toContain("payerAddress");
    expect(discoveryExample(schema)).toEqual(discoveryExample(structuredClone(schema)));
    expect(discoveryExample(schema)?.payerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(listing.requestSchema).not.toHaveProperty("properties.payerAddress");
  });

  it("falls back to a valid minimal declaration for unsupported examples while retaining the exact OpenAPI contract", () => {
    const unusual = { ...listing, requestSchema: { type: "object", properties: { huge: { type: "string", minLength: 20000, maxLength: 20000 } }, required: ["huge"], additionalProperties: false } };
    const extension = bazaarExtension(config, unusual);
    expect(extension.info).toHaveProperty("exampleUnavailable", true);
    expect(validateDiscoveryExtension(extension)).toEqual({ valid: true });
    expect(JSON.stringify(api([{ ...outcome, listing: unusual }]))).toContain('"minLength":20000');
  });

  it("restores omitted discovery for the facilitator without modifying payer authorization or its durable payload", () => {
    const payment = { x402Version: 2, resource: { url: listing.commitment.payload.absoluteResourceUri }, payload: { signature: "unchanged" }, extensions: { "payment-identifier": { info: { id: "original" } } } } as unknown as PaymentPayload;
    const before = JSON.stringify(payment);
    const enriched = facilitatorDiscoveryPayment(config, listing, payment);
    expect(JSON.stringify(payment)).toBe(before);
    expect(enriched.payload).toBe(payment.payload);
    expect(enriched.resource).toBe(payment.resource);
    expect(enriched.extensions?.["payment-identifier"]).toBe(payment.extensions?.["payment-identifier"]);
    expect(validateDiscoveryExtension(enriched.extensions!.bazaar as never)).toEqual({ valid: true });
  });

  it("keeps challenge metadata compact and replaces buyer-supplied discovery with complete public schemas", () => {
    const declaration = compactBazaarExtension(config, listing);
    // Validate the wire JSON: the SDK's TS convenience type fixes the verbose
    // builder schema, while Bazaar itself accepts equivalent JSON Schemas.
    const wireDeclaration = JSON.parse(JSON.stringify(declaration));
    expect(validateDiscoveryExtensionSpec(wireDeclaration)).toEqual({ valid: true });
    expect(validateDiscoveryExtension(wireDeclaration)).toEqual({ valid: true });
    expect(declaration.schema.properties.input.properties.body).toEqual({ type: "object" });
    expect(JSON.stringify(declaration).length).toBeLessThan(1500);
    const payment = { extensions: { bazaar: { info: { input: { body: { privateBuyerData: "must not index" } } } } } } as unknown as PaymentPayload;
    const enriched = facilitatorDiscoveryPayment(config, { ...listing, bazaarDeclaration: declaration }, payment);
    expect(enriched.extensions?.bazaar).toEqual(bazaarExtension(config, listing));
    expect(JSON.stringify(enriched)).not.toContain("privateBuyerData");
  });

  it("reads bounded optional facilitator indexing diagnostics without treating malformed metadata as a payment failure", () => {
    const header = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
    expect(facilitatorDiscoveryStatus(header({ bazaar: { status: "processing" } }))).toEqual({ status: "processing" });
    expect(facilitatorDiscoveryStatus(header({ bazaar: { status: "success" } }))).toEqual({ status: "success" });
    expect(facilitatorDiscoveryStatus(header({ bazaar: { status: "rejected", rejectedReason: "schema invalid" } }))).toEqual({ status: "rejected", rejectedReason: "schema invalid" });
    for (const value of [null, "!invalid", "a".repeat(20000), header({ bazaar: { status: "unknown" } }), header(null), header({ bazaar: [] })]) {
      expect(facilitatorDiscoveryStatus(value)).toBeNull();
    }
  });

  it("publishes concrete paid paths, exact USDC decimal prices, gateway servers, and explicit free reads", () => {
    const document = api();
    expect(document.servers).toEqual([{ url: config.publicUrl }]);
    expect(document.info["x-guidance"]).toContain("Recipe-bound");
    const operation = (document.paths["/outcomes/42/reserve-service"] as any).post;
    expect(operation["x-payment-info"]).toEqual({ protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: "9.99" } });
    expect(operation.requestBody.content["application/json"].schema.required).toEqual(["name", "quantity"]);
    expect(operation.responses).toHaveProperty("402");
    expect(operation.responses).toHaveProperty("202");
    expect((document.paths["/public/v2/outcomes"] as any).get.security).toEqual([]);
    const dynamic = api([{ ...outcome, listing: { ...listing, offer: { payload: { ...listing.offer.payload, pricingMode: "dynamic", fixedGrossAmount: "0" } } }, pricing: { USDC: { min_amount: "1990000", max_amount: "123456789" } } }]);
    expect((dynamic.paths["/outcomes/42/reserve-service"] as any).post["x-payment-info"].price).toEqual({ mode: "dynamic", currency: "USD", min: "1.99", max: "123.456789" });
  });

  it("rejects a resource URL outside the configured gateway", () => {
    expect(() => api([{ ...outcome, listing: { ...listing, commitment: { payload: { ...listing.commitment.payload, absoluteResourceUri: "https://other.example/purchase" } } } }])).toThrow("outside the gateway");
  });

  it("serves discovery without issuing any quote or payment", async () => {
    const app = express();
    app.use(createStandardRailRouter({ publicOpenApi: async () => api() } as never, config.publicUrl));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/openapi.json`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=30");
      expect((await response.json() as { openapi: string }).openapi).toBe("3.1.0");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
