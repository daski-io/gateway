import { describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createPool } from "../src/db/pool.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
// Dynamic imports deliberately load compiled production entrypoints. The CI
// build precedes tests; proof refuses an absent or stale compiled artifact.
const { proveAdmissions } = await import(new URL("../scripts/release-proof.mjs", import.meta.url).href);
const { proveStartup } = await import(new URL("../scripts/reliability/startup-proof.mjs", import.meta.url).href);
const { startupFixture, conflictingCatalogFixture, advancedCatalogFixture, postEpochFixture } =
  await import(new URL("../scripts/reliability/fixture.mjs", import.meta.url).href);
const { verifyBuildIdentity } = await import(new URL("../scripts/build-identity.mjs", import.meta.url).href);
const admissionInput = (fixture: any) => ({ schemaVersion: 1, priorState: fixture.priorState,
  candidateAdmissions: fixture.manifest.servicingAdmissions, expectedCurrent: fixture.expectedCurrent });

describe("candidate release execution proof", () => {
  it("rejects the existing-epoch catalog escape and proves the corrected actual transaction", async () => {
    const initial = await startupFixture();
    const conflicting = await conflictingCatalogFixture(initial);
    await expect(proveAdmissions(admissionInput(conflicting), databaseUrl))
      .rejects.toThrow("Current servicing admission is absent from the marketplace manifest");
    const corrected = await advancedCatalogFixture(initial);
    const proof = await proveAdmissions(admissionInput(corrected), databaseUrl);
    expect(proof).toMatchObject({ status: "PASS", boundary: "gateway-admission",
      checks: expect.arrayContaining(["actual-admission-transaction", "expected-current-admissions"]) });
    const future = corrected.manifest.servicingAdmissions.at(-1);
    const { canonicalHash } = await import("../src/standardRail/canonical.js");
    const activation = { ...admissionInput(corrected), targetEpochs: { "1": 2 },
      expectedCurrent: [{ providerAgentId: "1", admissionHash: canonicalHash(future) }] };
    expect(await proveAdmissions(activation, databaseUrl)).toMatchObject({ status: "PASS" });
    await expect(proveAdmissions({ ...activation, expectedCurrent: initial.expectedCurrent }, databaseUrl))
      .rejects.toThrow("activated admissions differ from the planned outcome");
  }, 60_000);

  it("boots the actual application on existing state, rejects conflict, and boots its correction", async () => {
    const initial = await startupFixture();
    const initialProof = await proveStartup({ ...initial, migrationThrough: "037_runtime_listing_commitments.sql" }, databaseUrl, { probe: async ({url, databaseUrl: isolated}: any) => {
      expect((await fetch(`${url}/.well-known/mcp.json`)).status).toBe(200);
      expect(await (await fetch(url+"/health/live")).json()).toMatchObject({network:"eip155:84532",chainId:84532});
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

  // The 2026-09-15 epoch reset erased the servicing-admission chain: the manifest's
  // epoch-2 admission could not activate on an empty table and the image did not boot.
  it("boots on the lineage an epoch reset restores and fails without it", async () => {
    const restored = await postEpochFixture(await startupFixture());
    const proof = await proveStartup(restored, databaseUrl);
    expect(proof).toMatchObject({ status: "PASS", checks: expect.arrayContaining(["existing-rail-lineage", "health-ready"]) });
    // The production logger redacts error messages, so the proof reports the generic
    // failure; the debug output pins it to the servicing-admission activation.
    let output = "";
    await expect(proveStartup({ ...restored, priorState: [], priorArtifacts: [], expectedCurrent: [] }, databaseUrl,
      { debug: (text: string) => { output = text; } })).rejects.toThrow("fatal startup failure");
    expect(output).toMatch(/admitManifest/);
  }, 120_000);

  it("recovers retained work on process startup before any HTTP health probe", async () => {
    let observed = false;
    const proof = await proveStartup(await startupFixture(), databaseUrl, {
      beforeSpawn: async ({ databaseUrl: isolated }: any) => {
        const pool = createPool({ connectionString: isolated, max: 1 });
        try {
          await pool.query(`INSERT INTO standard_orders
            (order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
             listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
             canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,
             expires_at,updated_at)
            VALUES ('unattended',$1,'unattended',$1,'CHALLENGE_ISSUED','1','outcome','recipe-bound-v2',
              $1,$1,'{}',$1,'{}',$1,'{}',$1,'int_12345678-1234-4123-8123-123456789abc',1000000,1,1,
              now()-interval '2 minutes',now()-interval '3 minutes')`, [Buffer.alloc(32,1)]);
        } finally { await pool.end(); }
      },
      beforeHealthProbe: async ({ databaseUrl: isolated }: any) => {
        const pool = createPool({ connectionString: isolated, max: 1 });
        try {
          // No HTTP request is issued until the compiled process's own worker
          // has resumed this pre-existing order on the actual database.
          for (let i=0;i<200;i++) {
            const row=(await pool.query("SELECT state FROM standard_orders WHERE order_id='unattended'")).rows[0];
            if(row.state==="NOT_SETTLED"){observed=true;break;}
            await new Promise(resolve=>setTimeout(resolve,100));
          }
          expect(observed).toBe(true);
          const transitions=(await pool.query("SELECT reason_code FROM standard_order_transitions WHERE order_id='unattended'")).rows;
          expect(transitions).toContainEqual({reason_code:"signed_deadline_no_captured_payment"});
          return { observed };
        } finally { await pool.end(); }
      },
    });
    expect(proof.checks).toContain("workers-without-health-traffic");
  }, 60_000);

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
