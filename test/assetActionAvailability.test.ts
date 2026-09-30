import { once } from "node:events";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { StandardAssetActions } from "../src/standardRail/assetActions.js";
import { claimAssetAction, recordAssetActionStage, recordAssetActionState } from "../src/standardRail/assetActionClaims.js";
import { artifactPayloadHash, canonicalHash } from "../src/standardRail/canonical.js";
import { createStandardRailRouter } from "../src/standardRail/routes.js";
import { signEnvelope } from "../src/standardRail/signing.js";
import type { WalletAuthorizationTransport } from "../src/standardRail/types.js";
import { utf8Hash, walletAuthorizationHash } from "../src/standardRail/walletAuthorization.js";
import type { StandardWalletStore } from "../src/standardRail/walletStore.js";

vi.mock("../src/standardRail/assetActionClaims.js", () => ({
  claimAssetAction: vi.fn(async () => undefined),
  recordAssetActionStage: vi.fn(async () => undefined),
  recordAssetActionState: vi.fn(async () => undefined),
  assertDestructiveFollowUp: vi.fn(async () => undefined),
}));
vi.mock("../src/standardRail/assetEligibility.js", () => ({
  isPayerEligibleForProvider: vi.fn(async () => true),
}));

const hash: Hex = `0x${"1".repeat(64)}`;
const payer: Hex = `0x${"2".repeat(40)}`;
const origin = "https://gateway.example";
const chainId = 84532;

function fixture(statuses: number[]) {
  const providerKey = generatePrivateKey();
  const now = Math.floor(Date.now() / 1_000);
  const definition = {
    actionId: "prepare-mailbox-dns", serviceId: hash, destructive: false,
    responseSchema: { type: "object", additionalProperties: false, required: ["ready"],
      properties: { ready: { type: "boolean" } } },
    validFrom: now - 60, validBefore: now + 600,
  };
  const actionDefinition = { ...definition, actionDefinitionHash: canonicalHash(definition) };
  const catalogEnvelope = { payload: { providerAgentId: "42", actions: [actionDefinition] } };
  const admission = {
    providerAgentId: "42", providerControlProfileHash: hash, servicingProfileEpoch: 1,
    actionCatalogHash: canonicalHash(catalogEnvelope), actionCatalogSchemaHash: hash,
    actionCatalogEpoch: 5, validBefore: now + 600,
  };
  const active = { admissionHash: hash, admissionEnvelope: { payload: admission },
    listing: { providerControlProfile: { payload: {
      assetResponseKeyId: "fixture", assetResponseKey: privateKeyToAccount(providerKey).address,
      assetActionUrl: "https://provider.example/actions", providerAudience: "https://provider.example",
      timeoutMs: 10_000, maxResponseBytes: 16_384,
    } } },
  };
  const request = { actionId: definition.actionId, providerAssetId: "11111111-1111-4111-8111-111111111111", input: {} };
  const authorization: WalletAuthorizationTransport = {
    message: {
      payer, providerAgentId: "42", serviceId: hash,
      providerControlProfileHash: hash, servicingAdmissionHash: hash,
      actionCatalogHash: canonicalHash(catalogEnvelope), actionCatalogSchemaHash: hash,
      actionCatalogEpoch: 5, actionDefinitionHash: actionDefinition.actionDefinitionHash,
      actionHash: utf8Hash("use-asset:42:prepare-mailbox-dns"), methodHash: utf8Hash("POST"),
      absoluteResourceUriHash: utf8Hash(origin + "/wallet/assets/action"),
      requestHash: canonicalHash(request), audienceHash: utf8Hash(origin),
      nonce: hash, issuedAt: now, validBefore: now + 300,
    },
    signature: "0x",
  };
  const authorizationHash = walletAuthorizationHash(authorization.message, chainId);
  // The wallet store proves the signature; this test exercises the action and HTTP boundaries.
  const consume = vi.fn(async (_args: Parameters<StandardWalletStore["consume"]>[0]) => ({
    payer, authorizationHash,
  }));
  const providerFetch = vi.fn(async (_active: unknown, _endpoint: string, init: RequestInit) => {
    const status = statuses.shift();
    if (status === undefined) throw new Error("unexpected provider call");
    if (status !== 200) return new Response("private provider diagnostics", { status });
    const { grant } = JSON.parse(String(init.body));
    const claim = vi.mocked(claimAssetAction).mock.calls.at(-1)![1];
    const payload = {
      providerAgentId: "42", payer, actionExecutionId: claim.executionId,
      status: "completed", responseNonce: hash, requestHash: canonicalHash(request),
      walletAuthorizationHash: authorizationHash, grantHash: artifactPayloadHash(grant),
      providerControlProfileHash: hash, servicingAdmissionHash: hash, servicingProfileEpoch: 1,
      actionCatalogHash: canonicalHash(catalogEnvelope), actionCatalogSchemaHash: hash,
      actionCatalogEpoch: 5, actionDefinitionHash: actionDefinition.actionDefinitionHash,
      result: { ready: true }, errorClass: null,
    };
    return Response.json(await signEnvelope({
      artifactType: "ProviderAssetActionResponseV1", environment: "test", chainId,
      audience: origin, signerKeyId: "fixture", privateKey: providerKey,
      issuedAt: now, validBefore: now + 60, payload,
    }));
  });
  const api = new StandardAssetActions({} as never, {
    environment: "test", gatewayAudience: origin, lifecyclePrivateKey: generatePrivateKey(),
    manifest: { actionCatalogs: [catalogEnvelope] },
  } as never, chainId, { consume } as never, { activeServicing: () => active } as never, providerFetch);
  return { api, consume, providerFetch, body: { payer, providerAgentId: "42", ...request, authorization } };
}

async function withEndpoint(
  api: StandardAssetActions,
  work: (url: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use(createStandardRailRouter({ performAssetAction: api.perform.bind(api) } as never, origin));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    await work(`http://127.0.0.1:${address.port}/wallet/assets/action`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe("provider asset-action HTTP failures", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps provider unavailability retryable and resumes the same signed execution", async () => {
    const { api, body, consume, providerFetch } = fixture([503, 200]);
    await withEndpoint(api, async url => {
      const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
      const unavailable = await fetch(url, init);
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("retry-after")).toBe("1");
      expect(await unavailable.json()).toEqual({ error: {
        code: "WALLET_TEMPORARILY_UNAVAILABLE",
        message: "The wallet request could not be completed right now; retry it unchanged",
      } });
      expect(recordAssetActionState).not.toHaveBeenCalled();
      expect(recordAssetActionStage).not.toHaveBeenCalled();

      const resumed = await fetch(url, init);
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({ status: "completed", result: { ready: true } });
      const claims = vi.mocked(claimAssetAction).mock.calls;
      expect(claims).toHaveLength(2);
      expect(claims[1]![1]).toEqual(claims[0]![1]);
      expect(recordAssetActionState).toHaveBeenCalledExactlyOnceWith({}, claims[0]![1].executionId, "completed");
      expect(consume.mock.calls.map(([args]) => args)).toEqual([
        expect.objectContaining({ authorization: body.authorization, allowExactReplay: true, operationHash: claims[0]![1].executionId }),
        expect.objectContaining({ authorization: body.authorization, allowExactReplay: true, operationHash: claims[0]![1].executionId }),
      ]);
      const sends = providerFetch.mock.calls.map(([, , init]) => JSON.parse(String(init.body)));
      expect(sends.map(send => send.authorization)).toEqual([body.authorization, body.authorization]);
    });
  });

  it.each([
    [403, 409, "ASSET_ACTION_REJECTED", null],
    [429, 429, "WALLET_RATE_LIMITED", "60"],
  ] as const)("preserves provider %s handling", async (providerStatus, publicStatus, code, retryAfter) => {
    const { api, body } = fixture([providerStatus]);
    await withEndpoint(api, async url => {
      const response = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(publicStatus);
      expect(response.headers.get("retry-after")).toBe(retryAfter);
      expect(await response.json()).toEqual({ error: { code, message: "The wallet request could not be completed" } });
      expect(recordAssetActionState).not.toHaveBeenCalled();
    });
  });
});
