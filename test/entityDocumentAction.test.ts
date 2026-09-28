import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { StandardAssetActions } from "../src/standardRail/assetActions.js";
import { artifactPayloadHash, canonicalHash } from "../src/standardRail/canonical.js";
import { compileClosedResponseSchema } from "../src/standardRail/schema.js";

const schema = JSON.parse(readFileSync(new URL("./fixtures/entity-document-download-result.schema.json", import.meta.url), "utf8"));
const hash = `0x${"1".repeat(64)}`;
const payer = `0x${"2".repeat(40)}`;
const download = {
  documentId: "fixture-document", title: "Bylaws", type: "bylaws", refreshAction: "download-entity-document",
  download: { url: "https://provider.example/services/entity-formation/entity-documents/fixture-token", method: "GET",
    mimeType: "application/pdf", expiresAt: "2026-09-28T18:15:00.000Z", singleUse: true },
};

async function fixture() {
  const signer = privateKeyToAccount(generatePrivateKey());
  const now = Math.floor(Date.now() / 1000);
  const definition = { actionId: "download-entity-document", responseSchema: schema,
    validFrom: now - 60, validBefore: now + 600, actionDefinitionHash: "" };
  const { actionDefinitionHash: _hash, ...unsignedDefinition } = definition;
  definition.actionDefinitionHash = canonicalHash(unsignedDefinition);
  const catalogEnvelope = { payload: { providerAgentId: "42", actions: [definition] } };
  const admission = { providerAgentId: "42", providerControlProfileHash: hash, servicingProfileEpoch: 1,
    actionCatalogHash: canonicalHash(catalogEnvelope), actionCatalogSchemaHash: hash, actionCatalogEpoch: 2 };
  const active = { admissionHash: hash, admissionEnvelope: { payload: admission }, listing: { providerControlProfile: {
    payload: { assetResponseKeyId: "fixture", assetResponseKey: signer.address },
  } } };
  const api = new StandardAssetActions({} as never, {
    environment: "test", gatewayAudience: "https://gateway.example", manifest: { actionCatalogs: [catalogEnvelope] },
  } as never, 84532, {} as never, { activeServicing: () => active } as never, async () => { throw new Error("unexpected fetch"); });
  const request = { actionId: definition.actionId, providerAssetId: "asset-fixture", input: { documentId: download.documentId } };
  const grant = { validBefore: now + 120 };
  const verify = async (result: unknown, overrides = {}) => {
    const unsigned = { artifactType: "ProviderAssetActionResponseV1", schemaVersion: 1, environment: "test", chainId: 84532,
      audience: "https://gateway.example", signerKeyId: "fixture", issuedAt: now, validBefore: now + 60,
      payload: { providerAgentId: "42", payer, actionExecutionId: hash, status: "completed", responseNonce: hash,
        requestHash: canonicalHash(request), walletAuthorizationHash: hash, grantHash: artifactPayloadHash(grant),
        providerControlProfileHash: hash, servicingAdmissionHash: hash, servicingProfileEpoch: 1,
        actionCatalogHash: canonicalHash(catalogEnvelope), actionCatalogSchemaHash: hash, actionCatalogEpoch: 2,
        actionDefinitionHash: definition.actionDefinitionHash, result, errorClass: null, ...overrides },
    };
    const envelope = { ...unsigned, signature: await signer.signMessage({ message: { raw: artifactPayloadHash(unsigned) } }) };
    // Exercise the production signature/binding/schema boundary, with no database or network.
    return (api as unknown as { verifyResponse(...args: unknown[]): Promise<Record<string, unknown>> }).verifyResponse(
      { active, catalogEnvelope, definition }, grant, envelope, payer, request, hash, hash,
      { artifactType: "ProviderAssetActionResponseV1", status: null },
    );
  };
  return { api, verify };
}

describe("admitted entity document response", () => {
  it("preserves the signed URL and metadata through response verification", async () => {
    const { verify } = await fixture();
    expect(await verify(download)).toMatchObject({ status: "completed", result: download });
  });
  it("rejects metadata-only completion and the old action marker", async () => {
    const { verify } = await fixture();
    const { download: _download, ...metadata } = download;
    await expect(verify(metadata)).rejects.toThrow();
    await expect(verify({ ...download, refreshAction: "document-download" })).rejects.toThrow();
  });
  it("rejects an otherwise valid result bound to an obsolete catalog", async () => {
    const { verify } = await fixture();
    await expect(verify(download, { actionCatalogEpoch: 1 })).rejects.toThrow("invalid response");
  });
  it("does not admit the internal token-purpose marker as a gateway action", async () => {
    const { api } = await fixture();
    await expect(api.issue({ payer, providerAgentId: "42", actionId: "document-download", providerAssetId: "asset-fixture",
      input: {}, absoluteResourceUri: "https://gateway.example/wallet/assets/action", clientKey: "fixture" }))
      .rejects.toThrow("ASSET_ACTION_NOT_ADMITTED");
  });
  it.each([
    { ...download, extra: true },
    { ...download, download: { ...download.download, mimeType: "text/html" } },
    { ...download, download: { ...download.download, singleUse: false } },
    { ...download, download: { ...download.download, url: "javascript:alert(1)" } },
  ])("rejects malformed results under the admitted closed schema", result => {
    expect(compileClosedResponseSchema(schema)(result)).toBe(false);
  });
});
