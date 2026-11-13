import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface ReleaseCapabilityManifest {
  schemaVersion: 1; role: "gateway"; commit: string;
  paidContracts: unknown[]; assetActions: unknown[]; intentFormats: string[]; workerFormats: string[];
  /** Encodings of public JSON variables this gateway decodes; absent before brotli support. */
  variableEncodings?: string[];
  /**
   * How a provider without a current servicing admission is sold when the
   * manifest carries several of its control profiles: "agent-wallet", through
   * the profile naming its registration's agent wallet (catalog.ts). Absent
   * on images that sold through the lowest epoch.
   */
  controlProfileSelection?: "agent-wallet";
}
export function parseReleaseCapabilityManifest(bytes: Buffer) {
  const artifact = JSON.parse(bytes.toString("utf8")) as ReleaseCapabilityManifest;
  if (artifact.schemaVersion !== 1 || artifact.role !== "gateway" || !/^[a-f0-9]{40}$/.test(artifact.commit) ||
      !["paidContracts","assetActions","intentFormats","workerFormats"].every(key =>
        Array.isArray(artifact[key as keyof ReleaseCapabilityManifest]))) {
    throw new Error("INVALID_RELEASE_CAPABILITY_MANIFEST");
  }
  return { artifact, artifactManifestHash: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
}
let cached: ReturnType<typeof parseReleaseCapabilityManifest> | null = null;
export function embeddedReleaseCapabilities() {
  // Compiled deployments always read their own immutable build artifact.
  // Source-mode tests/dev use the same generated dist artifact.
  const path = import.meta.url.endsWith(".ts")
    ? new URL("../../dist/release-capabilities.json", import.meta.url)
    : new URL("../release-capabilities.json", import.meta.url);
  return cached ??= parseReleaseCapabilityManifest(readFileSync(path));
}
