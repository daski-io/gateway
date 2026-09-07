import { describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createPool } from "../src/db/pool.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
// Dynamic imports deliberately load compiled production entrypoints. The CI
// build precedes tests; proof refuses an absent or stale compiled artifact.
const { proveAdmissions } = await import(new URL("../scripts/release-proof.mjs", import.meta.url).href);
const { proveStartup } = await import(new URL("../scripts/reliability/startup-proof.mjs", import.meta.url).href);
const { startupFixture, conflictingCatalogFixture, advancedCatalogFixture } =
  await import(new URL("../scripts/reliability/fixture.mjs", import.meta.url).href);
const { verifyBuildIdentity } = await import(new URL("../scripts/build-identity.mjs", import.meta.url).href);
const admissionInput = (fixture: any) => ({ schemaVersion: 1, priorState: fixture.priorState,
  candidateAdmissions: fixture.manifest.servicingAdmissions, expectedCurrent: fixture.expectedCurrent });

describe("candidate release execution proof", () => {
  it("rejects the existing-epoch catalog escape and proves the corrected actual transaction", async () => {
    const initial = await startupFixture();
    const conflicting = await conflictingCatalogFixture(initial);
    await expect(proveAdmissions(admissionInput(conflicting), databaseUrl))
      .rejects.toThrow("Servicing admission epoch conflicts with the activated admission");
    const corrected = await advancedCatalogFixture(initial);
    const proof = await proveAdmissions(admissionInput(corrected), databaseUrl);
    expect(proof).toMatchObject({ status: "PASS", boundary: "gateway-admission",
      checks: expect.arrayContaining(["actual-admission-transaction", "expected-current-admissions"]) });
    await expect(proveAdmissions({ ...admissionInput(corrected), expectedCurrent: initial.expectedCurrent }, databaseUrl))
      .rejects.toThrow("activated admissions differ from the planned outcome");
  }, 60_000);

  it("boots the actual application on existing state, rejects conflict, and boots its correction", async () => {
    const initial = await startupFixture();
    const initialProof = await proveStartup({ ...initial, migrationThrough: "037_runtime_listing_commitments.sql" }, databaseUrl, { probe: async ({url, databaseUrl: isolated}: any) => {
      expect((await fetch(`${url}/.well-known/mcp.json`)).status).toBe(200);
      const pool = createPool({ connectionString: isolated, max: 1 });
      try { expect((await pool.query("SELECT count(*)::int AS count FROM _migrations")).rows[0].count).toBeGreaterThan(40); }
      finally { await pool.end(); }
      return { status: "PASS", entrypoint: "http-mcp-metadata-and-migrations" };
    }});
    expect(initialProof).toMatchObject({ status: "PASS", execution: { entrypoint: "dist/index.js" } });
    await expect(proveStartup(await conflictingCatalogFixture(initial), databaseUrl)).rejects.toThrow(/startup failure/);
    const corrected = await proveStartup(await advancedCatalogFixture(initial), databaseUrl);
    expect(corrected).toMatchObject({ status: "PASS", checks: expect.arrayContaining(["health-ready"]) });
  }, 120_000);

  it("refuses a build recorded for a different source revision", () => {
    const path = new URL("../dist/build-identity.json", import.meta.url);
    const original = readFileSync(path);
    try {
      writeFileSync(path, JSON.stringify({ ...JSON.parse(original.toString()), sourceSha: "0".repeat(40) }));
      expect(() => verifyBuildIdentity()).toThrow("Build identity mismatch: sourceSha");
    } finally { writeFileSync(path, original); }
  });

  it("refuses output that changed after the candidate build", () => {
    const path = new URL("../dist/index.js", import.meta.url);
    const original = readFileSync(path);
    try {
      appendFileSync(path, "\n// stale build regression\n");
      expect(() => verifyBuildIdentity()).toThrow("Build identity mismatch: buildHash");
    } finally { writeFileSync(path, original); }
    expect(verifyBuildIdentity().buildHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
