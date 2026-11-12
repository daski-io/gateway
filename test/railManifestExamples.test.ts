import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { verifyStandardRailManifest, type ArtifactTrust } from "../src/standardRail/artifacts.js";
import {
  ADDRESSES, EXAMPLES_CONSUMERS, EXAMPLES_SCHEMA_VERSION, RAIL_MANIFEST_EXAMPLES_DIR, buildRailManifestExamples,
  serializeExamples, type KeyName, type RailManifestExamples,
} from "./helpers/railManifestExamples.js";

// Example rail manifests (test/fixtures/rail-manifest-examples/): complete
// signed manifests, each with the verdict the gateway's start-up check gives
// it. The builders in test/helpers/railManifestExamples.ts sign them with
// label-derived keys at a fixed clock; this file writes them, holds the
// committed bytes to the builders and runs every committed manifest through
// verifyStandardRailManifest. A repository that replays the gateway's manifest
// rules vendors the directory byte for byte and holds its own copy of the
// rules to the same verdicts.
//
// Regenerate after an intentional change to the manifest rules or the set:
//   UPDATE_RAIL_MANIFEST_EXAMPLES=1 npx vitest run test/railManifestExamples.test.ts

const update = process.env.UPDATE_RAIL_MANIFEST_EXAMPLES === "1";
const EXAMPLES = "examples.json";
const MANIFEST = "manifest.json";
const FILES = {
  "README.md": "How the set is generated, verified and vendored.",
  [EXAMPLES]: "The trust inputs, the clock, the synthetic keys and every example manifest with its verdict.",
} as const;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const file = (name: string) => path.join(RAIL_MANIFEST_EXAMPLES_DIR, name);

function checksums(): unknown {
  return {
    schemaVersion: EXAMPLES_SCHEMA_VERSION,
    name: "daski-rail-manifest-examples",
    synthetic: true,
    owner: "daski-io/gateway",
    consumers: EXAMPLES_CONSUMERS,
    generator: "test/railManifestExamples.test.ts (UPDATE_RAIL_MANIFEST_EXAMPLES=1 npx vitest run test/railManifestExamples.test.ts)",
    verifier: "test/railManifestExamples.test.ts",
    hash: "sha256 of the exact file bytes",
    files: Object.fromEntries(Object.entries(FILES).map(([name, purpose]) =>
      [name, { sha256: sha256(readFileSync(file(name))), purpose }])),
  };
}

describe("rail manifest examples", () => {
  let built: RailManifestExamples;

  beforeAll(async () => {
    built = await buildRailManifestExamples();
    if (update) {
      mkdirSync(RAIL_MANIFEST_EXAMPLES_DIR, { recursive: true });
      writeFileSync(file(EXAMPLES), serializeExamples(built));
      writeFileSync(file(MANIFEST), serializeExamples(checksums()));
    }
  });
  afterAll(() => { vi.useRealTimers(); });

  const committed = () => JSON.parse(readFileSync(file(EXAMPLES), "utf8")) as RailManifestExamples;
  /** The trust a gateway configured as the set states would verify with. */
  const trustOf = ({ trust }: RailManifestExamples): ArtifactTrust => ({
    environment: trust.environment,
    chainId: trust.chainId,
    gatewayAudience: trust.gatewayAudience,
    signers: new Map<string, readonly Address[]>(Object.entries(trust.trustedSigners)),
    // The manifest check reads neither splitter hash.
    splitterFactoryRuntimeCodeHash: `0x${"00".repeat(32)}`,
    splitterCreationCodeHash: `0x${"00".repeat(32)}`,
  });

  it("examples.json is exactly what the builders sign", () => {
    expect(existsSync(file(EXAMPLES)), `${EXAMPLES} is missing; run with UPDATE_RAIL_MANIFEST_EXAMPLES=1`).toBe(true);
    expect(readFileSync(file(EXAMPLES), "utf8")).toBe(serializeExamples(built));
  });

  it("manifest.json carries every file's checksum and the directory holds nothing else", () => {
    expect(readdirSync(RAIL_MANIFEST_EXAMPLES_DIR).sort()).toEqual([MANIFEST, ...Object.keys(FILES)].sort());
    expect(readFileSync(file(MANIFEST), "utf8")).toBe(serializeExamples(checksums()));
  });

  it("keeps the set synthetic: label-derived keys and example hosts only", () => {
    const keys = (committed().keys as { keys: Record<string, { address: string }> }).keys;
    for (const [name, key] of Object.entries(keys)) expect(key.address, name).toBe(ADDRESSES[name as KeyName]);
    for (const name of Object.keys(FILES)) {
      for (const url of readFileSync(file(name), "utf8").match(/https?:\/\/[^\s"'`)<]+/g) ?? []) {
        expect(new URL(url).hostname, `${name} names ${url}`).toMatch(/(^|\.)example$/);
      }
    }
  });

  it("gives every example a distinct id, at least one accepted and one refused", () => {
    const { examples } = committed();
    expect(new Set(examples.map((example) => example.id)).size).toBe(examples.length);
    for (const example of examples) {
      expect(example.id.startsWith(`${example.verdict}.`), example.id).toBe(true);
      expect(example.gatewayError === null, example.id).toBe(example.verdict === "accepted");
    }
    expect(examples.some((example) => example.verdict === "accepted")).toBe(true);
    expect(examples.some((example) => example.verdict === "refused")).toBe(true);
  });

  it("holds every committed manifest to its verdict under the gateway's start-up check", async () => {
    const set = committed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(set.clock.now * 1_000);
    for (const example of set.examples) {
      const check = verifyStandardRailManifest(example.manifest, trustOf(set));
      if (example.verdict === "accepted") await expect(check, example.id).resolves.toBeUndefined();
      else await expect(check, example.id).rejects.toThrow(new Error(example.gatewayError!));
    }
  });

  it("accepts no example once its envelopes have expired", async () => {
    const set = committed();
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const example of set.examples.filter((candidate) => candidate.verdict === "accepted")) {
      vi.setSystemTime(example.manifest.activeRailProfile.validBefore * 1_000);
      await expect(verifyStandardRailManifest(example.manifest, trustOf(set)), example.id)
        .rejects.toThrow("outside its validity window");
    }
  });
});
