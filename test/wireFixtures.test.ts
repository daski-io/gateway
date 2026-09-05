import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { mcpError, mcpJson } from "../src/mcp/util.js";
import { mcpSurfaceFixture } from "./helpers/mcpSurfaceFixture.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { StandardRailError, standardRailPublicError } from "../src/standardRail/errors.js";
import { orderActionChallengeIssued } from "../src/standardRail/orderAuthorization.js";
import { orderBindingExtension, paymentIdentifierExtension } from "../src/standardRail/payment.js";
import { signEnvelope } from "../src/standardRail/signing.js";
import { utf8Hash, walletChallenge, ZERO_HASH } from "../src/standardRail/walletAuthorization.js";
import {
  orderActionChallengeEnvelope,
  preparedPaymentChallengeResult,
  walletChallengeEnvelope,
} from "../src/standardRail/wireEnvelopes.js";

// Pair-contract fixtures. Every object below is produced by the SAME code the
// live gateway runs, with fixed inputs, so the committed JSON is the wire shape
// a buyer or provider must parse. Consumers vendor the files verbatim and run
// their parsers over them offline; the coordination repo fails PREP when a
// vendored copy differs. Nine of nine 2026-09-01 completions were two
// components disagreeing about one of these shapes, and on 2026-09-03 the
// published buyer CLI, which vendored nothing, could not read one result.
//
// Regenerate after an intentional shape change:
//   UPDATE_WIRE_FIXTURES=1 npx vitest run test/wireFixtures.test.ts
// then re-vendor into daski-test/test/fixtures/gateway-wire/,
// daski-provider/test/fixtures/gateway-wire/, and
// daski-buyer/test/fixtures/gateway-wire/ (the consumers index.json lists).

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "wire-fixtures");
const update = process.env.UPDATE_WIRE_FIXTURES === "1";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const address = (byte: string): Hex => `0x${byte.repeat(40)}` as Hex;
const CHAIN_ID = 84_532;
const PUBLIC_URL = "https://sandbox-gateway.daski.io";
const PROVIDER_AUDIENCE = "https://sandbox-provider.example";
const ISSUED_AT = 1_756_769_000;
const ORDER_ID = "ord_00000000-0000-4000-8000-000000000001";
const INTENT_ID = "int_00000000-0000-4000-8000-000000000002";
const PROVIDER_TASK_ID = "task-00000000-0000-4000-8000-000000000003";
const ORDER_HANDLE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CORRELATION_ID = "00000000-0000-4000-8000-00000000c0de";
// Hardhat's first well-known development key: a public test vector, never a
// production signer. Deterministic ECDSA makes the grant signature stable.
const FIXTURE_SIGNER_KEY: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function mcpResultFixture() {
  const paymentRequired = {
    x402Version: 2,
    resource: { url: `${PUBLIC_URL}/outcomes/8327/register-domain`, mimeType: "application/json" },
    accepts: [],
    extensions: { "payment-identifier": paymentIdentifierExtension(INTENT_ID) },
  };
  return {
    // Ordinary results carry the payload in structuredContent AND as the same
    // serialized JSON in the text block (MCP 2025-06-18 SHOULD). The one-line
    // text summary of 2026-09-01 blinded every text-only reader; restored
    // 2026-09-03.
    success: mcpJson({ orderHandle: ORDER_HANDLE, state: "FULFILLED" }),
    // Errors carry the payload in both places too.
    error: mcpError({
      code: "WALLET_ACCESS_DENIED",
      message: "Wallet authorization rejected",
      retryable: false,
    }),
    // The purchase challenge additionally mirrors the JSON in _meta so stock
    // x402 clients can read it.
    paymentRequired: {
      ...mcpJson(paymentRequired, { "x402/payment-required": paymentRequired }),
      isError: true,
    },
  };
}

function preparedPaymentChallengeFixture() {
  // accepts[0] carries exactly the fields paymentRequirementsFor emits.
  const paymentRequired = {
    x402Version: 2,
    resource: { url: `${PUBLIC_URL}/outcomes/8327/register-domain`, mimeType: "application/json" },
    accepts: [{
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "5990000",
      payTo: address("2"),
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
    }],
    extensions: paymentRequiredExtensionsFixture(),
  };
  // The prepare tool's body nests the challenge beside its preflight, and the
  // challenge is mirrored into _meta where the unpaid buy call also puts it.
  return preparedPaymentChallengeResult({
    orderHandle: ORDER_HANDLE,
    paymentRequired,
    preflight: {
      payer: address("a"),
      network: "eip155:84532",
      usdcBalance: "20000000",
      sufficient: true,
      payerAllowed: true,
      intentId: INTENT_ID,
      approvalSummary:
        "Buy register-domain from Example Provider LLC for 5.99 USDC (Base Sepolia). " +
        "Challenge expires in 300s.",
    },
  });
}

function paymentRequiredExtensionsFixture() {
  const deal = {
    listingManifestHash: hash("1"),
    providerOfferHash: hash("2"),
    quoteHash: hash("3"),
    canonicalRequestHash: hash("4"),
    orderNonce: hash("5"),
    expiresAt: ISSUED_AT + 300,
  };
  return {
    "payment-identifier": paymentIdentifierExtension(INTENT_ID),
    "daski-order-binding": {
      "recipe-bound-v2": orderBindingExtension({ bindingProfile: "recipe-bound-v2", ...deal }),
      "recipe-bound-v1": orderBindingExtension({ bindingProfile: "recipe-bound-v1", ...deal }),
    },
  };
}

function walletChallengeFixture() {
  const request = { limit: 25, cursor: null };
  const message = {
    payer: address("a"),
    providerAgentId: "0",
    serviceId: ZERO_HASH,
    providerControlProfileHash: ZERO_HASH,
    servicingAdmissionHash: ZERO_HASH,
    actionCatalogHash: ZERO_HASH,
    actionCatalogSchemaHash: ZERO_HASH,
    actionDefinitionHash: ZERO_HASH,
    actionCatalogEpoch: 0,
    actionHash: utf8Hash("list-orders"),
    methodHash: utf8Hash("POST"),
    absoluteResourceUriHash: utf8Hash(`${PUBLIC_URL}/wallet/orders`),
    requestHash: canonicalHash(request),
    audienceHash: utf8Hash(PUBLIC_URL),
    nonce: hash("6"),
    issuedAt: ISSUED_AT,
    validBefore: ISSUED_AT + 300,
  };
  // HTTP /wallet/* routes and the wallet MCP tools return this very object.
  return walletChallengeEnvelope(walletChallenge(message, CHAIN_ID));
}

function orderActionChallengeFixture() {
  const challenge = {
    orderId: ORDER_ID,
    action: "status" as const,
    method: "POST" as const,
    absoluteResourceUri: `${PUBLIC_URL}/orders/${ORDER_HANDLE}/actions/status`,
    requestHash: canonicalHash({}),
    nonce: hash("7"),
    issuedAt: ISSUED_AT,
    validBefore: ISSUED_AT + 300,
  };
  return orderActionChallengeEnvelope(orderActionChallengeIssued({
    challenge,
    chainId: CHAIN_ID,
    gatewayAudience: PUBLIC_URL,
  }));
}

function standardRailErrorFixture() {
  const http = (error: StandardRailError) => ({ error: standardRailPublicError(error, PUBLIC_URL) });
  return {
    // No serverTime: a plain lifecycle refusal (completion 1 required it).
    walletAuthorizationInvalid: http(new StandardRailError("WALLET_AUTHORIZATION_INVALID", {
      correlationId: CORRELATION_ID,
    })),
    // serverTime present: timing-related refusals carry it.
    authorizationWindow: http(new StandardRailError("AUTHORIZATION_WINDOW", {
      serverTime: ISSUED_AT,
      correlationId: CORRELATION_ID,
    })),
    requestSchemaInvalid: http(new StandardRailError("REQUEST_SCHEMA_INVALID", {
      message: "Request body does not match the outcome schema",
      fieldErrors: [{ path: "/registrantState", rule: "pattern", message: "must match pattern" }],
      correlationId: CORRELATION_ID,
    })),
    // The MCP wallet surface answers refusals through mcpError.
    mcpWalletAccessDenied: mcpError({
      code: "WALLET_ACCESS_DENIED",
      message: "Wallet authorization rejected",
      retryable: false,
    }),
  };
}

async function providerLifecycleRequestFixture() {
  const authorization = { type: "DaskiReadCap", scope: "status" };
  const request = {};
  const grant = await signEnvelope({
    artifactType: "ProviderLifecycleGrantV1",
    environment: "testnet",
    chainId: CHAIN_ID,
    audience: PROVIDER_AUDIENCE,
    signerKeyId: "gateway-lifecycle",
    privateKey: FIXTURE_SIGNER_KEY,
    issuedAt: ISSUED_AT,
    validBefore: ISSUED_AT + 120,
    payload: {
      orderId: ORDER_ID,
      providerTaskId: PROVIDER_TASK_ID,
      action: "status",
      requestHash: canonicalHash(request),
      authorizationHash: canonicalHash(authorization),
      payer: address("a"),
    },
  });
  // The exact body service.performAction POSTs to the provider's lifecycle URL
  // for a capability read (completion 2: the provider demanded the nine-key
  // signed authorization instead of this stub).
  return {
    orderId: ORDER_ID,
    providerTaskId: PROVIDER_TASK_ID,
    action: "status",
    request,
    authorization,
    grant,
    payer: address("a"),
    gatewayAudience: PUBLIC_URL,
  };
}

const fixtures: Record<string, () => unknown | Promise<unknown>> = {
  "mcp-tool-surface.json": mcpSurfaceFixture,
  "mcp-result.json": mcpResultFixture,
  "payment-challenge-prepared.json": preparedPaymentChallengeFixture,
  "payment-required-extensions.json": paymentRequiredExtensionsFixture,
  "wallet-challenge.json": walletChallengeFixture,
  "order-action-challenge.json": orderActionChallengeFixture,
  "standard-rail-error.json": standardRailErrorFixture,
  "provider-lifecycle-request.json": providerLifecycleRequestFixture,
};

describe("wire fixtures", () => {
  for (const [file, build] of Object.entries(fixtures)) {
    it(`${file} is exactly what the gateway emits`, async () => {
      const value = JSON.parse(JSON.stringify(await build())) as unknown;
      const target = path.join(fixturesDir, file);
      if (update) {
        mkdirSync(fixturesDir, { recursive: true });
        writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
      }
      expect(existsSync(target), `${file} is missing — run with UPDATE_WIRE_FIXTURES=1`).toBe(true);
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(value);
    });
  }

  it("index.json lists every fixture and nothing else", () => {
    const index = JSON.parse(readFileSync(path.join(fixturesDir, "index.json"), "utf8")) as {
      fixtures: Record<string, { consumers: string[] }>;
    };
    const onDisk = readdirSync(fixturesDir).filter((name) => name !== "index.json").sort();
    expect(Object.keys(index.fixtures).sort()).toEqual(Object.keys(fixtures).sort());
    expect(onDisk).toEqual(Object.keys(fixtures).sort());
    for (const entry of Object.values(index.fixtures)) {
      expect(entry.consumers.length).toBeGreaterThan(0);
    }
  });

  it("ordinary results carry the serialized JSON in the text block and in structuredContent", () => {
    const { success } = mcpResultFixture();
    expect(success.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ orderHandle: ORDER_HANDLE, state: "FULFILLED" }),
    });
    expect(success.structuredContent).toEqual({ orderHandle: ORDER_HANDLE, state: "FULFILLED" });
  });

  it("the prepared challenge nests paymentRequired beside preflight and mirrors it in _meta", () => {
    const prepared = preparedPaymentChallengeFixture();
    const body = prepared.structuredContent as { paymentRequired: unknown; preflight: { intentId: string } };
    expect(prepared._meta?.["x402/payment-required"]).toEqual(body.paymentRequired);
    expect(body.preflight.intentId).toBe(INTENT_ID);
    expect(prepared.isError).toBeUndefined();
  });

  it("wallet and order-action challenges nest the sign request under `challenge`", () => {
    const wallet = walletChallengeFixture();
    const action = orderActionChallengeFixture();
    expect(wallet.authorizationRequired).toBe(true);
    expect(wallet.challenge.signRequest.domain.name).toBe("DaskiStandardWallet");
    expect(action.authorizationRequired).toBe(true);
    expect(action.challenge.signRequest.domain.name).toBe("DaskiStandardOrder");
  });
});
