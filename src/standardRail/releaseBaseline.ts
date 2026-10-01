export interface CommerceBaseline {
  schemaVersion: 1;
  role: "gateway" | "provider";
  network: string;
  observedAt: string;
  sources: Array<{ deploymentId: string; digest: string }>;
  offered: Array<{ serviceId: string; serviceSlug: string; skillId: string;
    skillContractHash: string; listingManifestHash: string; localPrerequisites: string[] }>;
}

export function parseCommerceBaseline(raw: string | undefined): CommerceBaseline | undefined {
  if (!raw?.trim()) return undefined;
  const value = JSON.parse(raw) as CommerceBaseline;
  if (!value || value.schemaVersion !== 1 || value.role !== "gateway" ||
      typeof value.network !== "string" || !Number.isFinite(Date.parse(value.observedAt)) ||
      !Array.isArray(value.sources) || !Array.isArray(value.offered) ||
      value.sources.some(source => typeof source.deploymentId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(source.digest)) ||
      value.offered.some(item => !/^0x[0-9a-f]{64}$/.test(item.serviceId) ||
        typeof item.serviceSlug !== "string" || typeof item.skillId !== "string" ||
        !/^0x[0-9a-f]{64}$/.test(item.skillContractHash) || !/^0x[0-9a-f]{64}$/.test(item.listingManifestHash) ||
        !Array.isArray(item.localPrerequisites) || item.localPrerequisites.some(name => !/^[A-Z][A-Z0-9_]*$/.test(name)))) {
    throw new Error("DASKI_COMMERCE_BASELINE_JSON is malformed");
  }
  return value;
}

export function parseTargetEpochs(raw: string | undefined): Record<string, number> | undefined {
  if (!raw?.trim()) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.entries(value).some(([id, epoch]) => !/^(0|[1-9][0-9]{0,77})$/.test(id) ||
        !Number.isSafeInteger(epoch) || (epoch as number) < 1)) {
    throw new Error("STANDARD_RAIL_ASSET_ACTION_TARGET_EPOCHS_JSON is malformed");
  }
  return value as Record<string, number>;
}
