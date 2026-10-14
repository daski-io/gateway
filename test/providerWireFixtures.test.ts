import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The gateway draws dispatch, order and action nonces from randomBytes; the
// fixtures plan each one so every envelope regenerates byte for byte.
const entropy = vi.hoisted(() => ({ queue: [] as Buffer[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomBytes = (size: number) => {
    const planned = entropy.queue.shift();
    if (planned && planned.length !== size) throw new Error("Planned entropy has the wrong size");
    return planned ?? actual.randomBytes(size);
  };
  return { ...actual, randomBytes };
});

import { FIXTURE_SCHEMA_VERSION, PROVIDER_WIRE_DIR, STARTERS, serializeFixture, sha256 } from "./helpers/providerWire.js";
import { FIXTURE_FILES, buildProviderWireFixtures } from "./helpers/providerWireVectors.js";

// Canonical provider-wire fixtures (test/fixtures/provider-wire/). Every
// request is what the gateway's own builders and signers send, driven with
// synthetic keys, a fixed clock and planned nonces; every answer is built by
// the reference provider in test/helpers/providerWire.ts. The consumer test
// (providerWireConsumer.test.ts) runs each answer through the gateway's
// validation and holds it to its declared verdict. daski-io/provider and
// daski-io/provider-full vendor the directory byte for byte, pinned to a
// gateway commit and manifest.json's checksums.
//
// Regenerate after an intentional contract change:
//   UPDATE_PROVIDER_WIRE_FIXTURES=1 npx vitest run test/providerWireFixtures.test.ts
// then re-vendor into both starters.

const update = process.env.UPDATE_PROVIDER_WIRE_FIXTURES === "1";
const MANIFEST = "manifest.json";
const STATIC_FILES = ["README.md"];

function manifest(): unknown {
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    name: "daski-provider-wire",
    synthetic: true,
    owner: "daski-io/gateway",
    consumers: STARTERS,
    generator: "test/providerWireFixtures.test.ts (UPDATE_PROVIDER_WIRE_FIXTURES=1 npx vitest run test/providerWireFixtures.test.ts)",
    verifier: "test/providerWireConsumer.test.ts",
    hash: "sha256 of the exact file bytes",
    files: Object.fromEntries(Object.entries(FIXTURE_FILES).map(([name, entry]) => [name, {
      sha256: sha256(readFileSync(path.join(PROVIDER_WIRE_DIR, name))),
      purpose: entry.purpose,
      consumers: STARTERS,
      exercises: entry.exercises,
    }])),
  };
}

describe("provider wire fixtures", () => {
  let built: Record<string, unknown> = {};

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      built = await buildProviderWireFixtures(entropy);
    } finally {
      vi.useRealTimers();
    }
    if (update) {
      mkdirSync(PROVIDER_WIRE_DIR, { recursive: true });
      for (const [name, value] of Object.entries(built)) writeFileSync(path.join(PROVIDER_WIRE_DIR, name), serializeFixture(value));
      writeFileSync(path.join(PROVIDER_WIRE_DIR, MANIFEST), serializeFixture(manifest()));
    }
  });
  afterAll(() => { entropy.queue.length = 0; });

  const generated = Object.keys(FIXTURE_FILES).filter((name) => !STATIC_FILES.includes(name));
  for (const name of generated) {
    it(`${name} is exactly what the gateway sends and the reference provider answers`, () => {
      const target = path.join(PROVIDER_WIRE_DIR, name);
      expect(existsSync(target), `${name} is missing; run with UPDATE_PROVIDER_WIRE_FIXTURES=1`).toBe(true);
      expect(readFileSync(target, "utf8")).toBe(serializeFixture(built[name]));
    });
  }

  it("draws no planned entropy it did not use", () => {
    expect(entropy.queue).toHaveLength(0);
  });

  it("manifest.json carries every file's checksum and the directory holds nothing else", () => {
    const listed = [MANIFEST, ...Object.keys(FIXTURE_FILES)].sort();
    expect(readdirSync(PROVIDER_WIRE_DIR).sort()).toEqual(listed);
    expect(Object.keys(built).sort()).toEqual(generated.sort());
    expect(readFileSync(path.join(PROVIDER_WIRE_DIR, MANIFEST), "utf8")).toBe(serializeFixture(manifest()));
  });

  it("keeps the set synthetic: test-only keys, example domains, no real endpoint", () => {
    for (const name of readdirSync(PROVIDER_WIRE_DIR).filter((file) => file.endsWith(".json"))) {
      const text = readFileSync(path.join(PROVIDER_WIRE_DIR, name), "utf8");
      for (const url of text.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
        expect(new URL(url).hostname, `${name} names ${url}`).toMatch(/(^|\.)example$/);
      }
    }
  });
});
