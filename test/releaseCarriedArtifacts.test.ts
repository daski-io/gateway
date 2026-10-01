import { describe, expect, it } from "vitest";
import { verifyStandardRailManifest } from "../src/standardRail/artifacts.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { signEnvelope } from "../src/standardRail/signing.js";
const { startupFixture, advancedCatalogFixture, testKey } =
  await import(new URL("../scripts/reliability/fixture.mjs", import.meta.url).href);

describe("signed carried admission bundles", () => {
  it("carries unchanged immutable actions across profiles and rejects identity changes", async () => {
    const initial = await startupFixture();
    const catalog = initial.manifest.actionCatalogs[0];
    const definition = { providerAgentId: "1", serviceId: "0x" + "a".repeat(64),
      serviceSlug: "example", actionId: "read-example", assetType: "example",
      ownershipPolicy: "owner-only", destructive: false,
      requestSchema: { type: "object", properties: {}, additionalProperties: false },
      responseSchema: { type: "object", properties: {}, additionalProperties: false },
      confirmationSummarySchema: null, confirmationSummaryTemplate: null,
      endpoint: initial.manifest.providerControlProfiles[0].payload.assetActionUrl,
      replayPolicy: "stable-result", retentionSeconds: 3600,
      validFrom: catalog.issuedAt - 5, validBefore: catalog.validBefore };
    catalog.payload.actions = [{ ...definition, actionDefinitionHash: canonicalHash(definition) }];
    initial.manifest.actionCatalogs[0] = await signEnvelope({ ...catalog, privateKey: testKey });
    initial.manifest.servicingAdmissions[0].payload.actionCatalogHash = canonicalHash(initial.manifest.actionCatalogs[0]);
    initial.manifest.servicingAdmissions[0] = await signEnvelope({ ...initial.manifest.servicingAdmissions[0], privateKey: testKey });
    initial.priorState[0].admission = initial.manifest.servicingAdmissions[0];
    initial.expectedCurrent[0].admissionHash = canonicalHash(initial.manifest.servicingAdmissions[0]);
    const carried = await advancedCatalogFixture(initial);
    const trust = { environment: "testnet", chainId: 84532, gatewayAudience: "https://gateway.reliability.invalid",
      signers: new Map(Object.entries(initial.trustedSigners)) as never,
      splitterFactoryRuntimeCodeHash: ("0x" + "1".repeat(64)) as `0x${string}`,
      splitterCreationCodeHash: ("0x" + "2".repeat(64)) as `0x${string}` };
    await expect(verifyStandardRailManifest(carried.manifest, trust)).resolves.toBeUndefined();
    const futureCatalog = carried.manifest.actionCatalogs[1];
    const changed = { ...definition, retentionSeconds: 7200 };
    futureCatalog.payload.actions = [{ ...changed, actionDefinitionHash: canonicalHash(changed) }];
    carried.manifest.actionCatalogs[1] = await signEnvelope({ ...futureCatalog, privateKey: testKey });
    const futureAdmission = carried.manifest.servicingAdmissions[1];
    futureAdmission.payload.actionCatalogHash = canonicalHash(carried.manifest.actionCatalogs[1]);
    carried.manifest.servicingAdmissions[1] = await signEnvelope({ ...futureAdmission, privateKey: testKey });
    await expect(verifyStandardRailManifest(carried.manifest, trust)).rejects.toThrow("immutable definition");
  });
});
