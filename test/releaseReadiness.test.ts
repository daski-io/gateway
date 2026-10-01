import { describe, expect, it, vi } from "vitest";
import { parseCommerceBaseline, parseTargetEpochs } from "../src/standardRail/releaseBaseline.js";
import { parseReleaseCapabilityManifest } from "../src/standardRail/releaseCapabilities.js";
import { StandardRailService } from "../src/standardRail/service.js";

describe("local commerce readiness", () => {
  const hash = "0x" + "1".repeat(64);
  const baseline = { schemaVersion: 1, role: "gateway", network: "eip155:84532",
    observedAt: "2020-01-01T00:00:00Z", sources: [{ deploymentId: "old", digest: "sha256:" + "a".repeat(64) }],
    offered: [{ serviceId: hash, serviceSlug: "service", skillId: "skill", skillContractHash: hash,
      listingManifestHash: hash, localPrerequisites: ["REQUIRED_KEY"] }] };
  const build = () => {
    const service = Object.create(StandardRailService.prototype);
    Object.assign(service, { locallyReady: true, pool: { query: vi.fn(async () => ({ rows: [] })) },
      assetFederation: { activateAdmissions: vi.fn(async () => undefined) },
      railConfig: { commerceBaseline: parseCommerceBaseline(JSON.stringify(baseline)), localPrerequisites: new Set(["REQUIRED_KEY"]) },
      appConfig: { x402Network: "eip155:84532" },
      catalog: { validateCommerce: vi.fn(async () => baseline.offered.map(item => ({ ...item, compiled: true }))) },
      refreshDependencyReadiness: vi.fn(() => { throw new Error("external probe must not gate readiness"); }) });
    return service;
  };
  it("accepts an old baseline observation using only actual local compilation", async () => {
    const service = build();
    expect(await service.commerceReadiness()).toBe(true);
    expect(service.assetFederation.activateAdmissions).toHaveBeenCalledWith({ readOnly: true });
    expect(service.catalog.validateCommerce).toHaveBeenCalledWith([hash]);
    expect(service.refreshDependencyReadiness).not.toHaveBeenCalled();
  });
  it("fails candidate readiness on missing local prerequisites, schemas, or baseline contracts", async () => {
    const service = build();
    service.railConfig.localPrerequisites.clear();
    expect(await service.commerceReadiness()).toBe(false);
    service.railConfig.localPrerequisites.add("REQUIRED_KEY");
    service.catalog.validateCommerce.mockResolvedValue([]);
    expect(await service.commerceReadiness()).toBe(false);
    service.catalog.validateCommerce.mockRejectedValue(new Error("unsupported schema"));
    expect(await service.commerceReadiness()).toBe(false);
  });
  it("rejects unsafe target epochs and binds capability identity to exact artifact bytes", () => {
    expect(() => parseTargetEpochs('{"1":9007199254740992}')).toThrow();
    const manifest = { schemaVersion: 1, role: "gateway", commit: "a".repeat(40),
      paidContracts: [], assetActions: [], intentFormats: ["ProviderServiceRegistrationIntentV1"], workerFormats: [] };
    const one = parseReleaseCapabilityManifest(Buffer.from(JSON.stringify(manifest)));
    const two = parseReleaseCapabilityManifest(Buffer.from(JSON.stringify(manifest) + "\n"));
    expect(one.artifactManifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(one.artifactManifestHash).not.toEqual(two.artifactManifestHash);
  });
});
