import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPool, runMigrations } from "../src/db/pool.js";
import { ServiceRegistrationStore } from "../src/serviceRegistration/store.js";
import { StandardAssetFederation } from "../src/standardRail/assetFederation.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import {
  ADMITTED_PROVIDER, CHAIN_ID, PROFILE_ONLY_PROVIDER, RAIL_MANIFEST_EXAMPLES_DIR, type RailManifestExamples,
} from "./helpers/railManifestExamples.js";

// The servicing-admission table under the committed accepted.shared-origin
// manifest: two providers on one origin, one admitted for servicing and one
// with a control profile only. Listing assembly reads this table to choose a
// provider's control profile (catalog.ts), so sharedOriginProviders.test.ts
// stands on what is proven here against the real schema.

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const { manifest } = (JSON.parse(
  readFileSync(path.join(RAIL_MANIFEST_EXAMPLES_DIR, "examples.json"), "utf8"),
) as RailManifestExamples).examples.find((example) => example.id === "accepted.shared-origin")!;

describe("servicing admissions of two providers on one origin", () => {
  it("activate the admitted provider's admission and record nothing for the profile-only provider", async () => {
    const schema = `shared_origin_${randomUUID().replaceAll("-", "")}`;
    const admin = createPool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 3 });
    try {
      await runMigrations(pool);
      const federation = new StandardAssetFederation(
        pool, { manifest } as unknown as StandardRailConfig, CHAIN_ID, {} as never,
        async () => { throw new Error("no provider is called"); },
      );
      await federation.activateAdmissions();
      // A restart checks the same state without writing.
      await federation.activateAdmissions({ readOnly: true });

      const recorded = await pool.query<{ provider_agent_id: string; current: boolean }>(
        "SELECT provider_agent_id,current FROM standard_provider_servicing_admissions");
      expect(recorded.rows).toEqual([{ provider_agent_id: ADMITTED_PROVIDER, current: true }]);
      const store = new ServiceRegistrationStore(pool);
      const admittedProfile = manifest.providerControlProfiles.find((profile) =>
        profile.payload.providerAgentId === ADMITTED_PROVIDER)!;
      expect(await store.currentProviderControlProfileHash(ADMITTED_PROVIDER)).toBe(canonicalHash(admittedProfile));
      expect(await store.currentProviderControlProfileHash(PROFILE_ONLY_PROVIDER)).toBeNull();
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  }, 60_000);
});
