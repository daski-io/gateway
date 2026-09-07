import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool, runMigrations } from "../src/db/pool.js";
import { StandardAssetFederation } from "../src/standardRail/assetFederation.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import type {
  ProviderServicingAdmissionV1,
  SignedEnvelope,
} from "../src/standardRail/types.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const hash = (digit: string) => `0x${digit.repeat(64)}` as const;

function admission(args: {
  providerAgentId: string;
  epoch: number;
  previousAdmissionHash: `0x${string}`;
  enabled: boolean;
  catalogEpoch?: number;
  catalogHash?: `0x${string}`;
}): SignedEnvelope<ProviderServicingAdmissionV1> {
  const now = Math.floor(Date.now() / 1_000);
  return {
    artifactType: "ProviderServicingAdmissionV1",
    schemaVersion: 1,
    environment: "testnet",
    chainId: 84_532,
    audience: "gateway",
    signerKeyId: "release",
    issuedAt: now - 10,
    validBefore: now + 3_600,
    payload: {
      providerAgentId: args.providerAgentId,
      providerControlProfileHash: hash("1"),
      actionCatalogHash: args.catalogHash ?? hash("2"),
      actionCatalogSchemaHash: hash("3"),
      servicingProfileEpoch: args.epoch,
      actionCatalogEpoch: args.catalogEpoch ?? 1,
      servicingEnabled: args.enabled,
      validFrom: now - 10,
      validBefore: now + 3_600,
      previousAdmissionHash: args.previousAdmissionHash,
    },
    signature: `0x${"00".repeat(65)}`,
  };
}

function federation(
  pool: ReturnType<typeof createPool>,
  admissions: SignedEnvelope<ProviderServicingAdmissionV1>[],
): StandardAssetFederation {
  const config = {
    manifest: { servicingAdmissions: admissions, listings: [] },
  } as unknown as StandardRailConfig;
  return new StandardAssetFederation(
    pool,
    config,
    84_532,
    {} as never,
    async () => new Response(null, { status: 503 }),
  );
}

describe("servicing-admission activation against PostgreSQL", () => {
  it("activates only a contiguous chain and persists a signed suspension", async () => {
    const schema = `servicing_admission_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 2 });
    try {
      await runMigrations(pool);

      const active = admission({
        providerAgentId: "1", epoch: 1, previousAdmissionHash: hash("0"), enabled: true,
      });
      const suspended = admission({
        providerAgentId: "1",
        epoch: 2,
        previousAdmissionHash: canonicalHash(active),
        enabled: false,
      });
      const service = federation(pool, [active, suspended]);
      await service.activateAdmissions();
      expect(service.activeServicing("1")).toBeNull();
      const current = await pool.query<{
        epoch: number;
        enabled: boolean;
  catalogEpoch?: number;
  catalogHash?: `0x${string}`;
        current_count: number;
      }>(`SELECT
          (canonical_admission->'payload'->>'servicingProfileEpoch')::int AS epoch,
          (canonical_admission->'payload'->>'servicingEnabled')::boolean AS enabled,
          count(*) FILTER (WHERE current) OVER ()::int AS current_count
        FROM standard_provider_servicing_admissions WHERE current`);
      expect(current.rows).toEqual([{ epoch: 2, enabled: false, current_count: 1 }]);

      const skipped = admission({
        providerAgentId: "2", epoch: 2, previousAdmissionHash: hash("0"), enabled: true,
      });
      await expect(federation(pool, [skipped]).activateAdmissions())
        .rejects.toThrow("Servicing admission chain is invalid");
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  }, 60_000);

  it("rejects changed catalog in the active profile epoch and rolls back partial activation", async () => {
    const schema = `servicing_transition_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 2 });
    try {
      await runMigrations(pool);
      const active = admission({ providerAgentId: "1", epoch: 1,
        previousAdmissionHash: hash("0"), enabled: true });
      await federation(pool, [active]).activateAdmissions();
      const snapshot = async () => (await pool.query(`SELECT encode(admission_hash,'hex') AS hash,
        current,canonical_admission FROM standard_provider_servicing_admissions ORDER BY admission_hash`)).rows;
      const before = await snapshot();
      // The catalog epoch can change while the serving profile stays the same.
      // A clean-schema boot missed this because it had no activated admission.
      const conflict = admission({ providerAgentId: "1", epoch: 1, catalogEpoch: 2,
        catalogHash: hash("4"), previousAdmissionHash: hash("0"), enabled: true });
      await expect(federation(pool, [conflict]).activateAdmissions())
        .rejects.toThrow("Servicing admission epoch conflicts with the activated admission");
      expect(await snapshot()).toEqual(before);

      const next = admission({ providerAgentId: "1", epoch: 2, catalogEpoch: 2,
        catalogHash: hash("4"), previousAdmissionHash: canonicalHash(active), enabled: true });
      const brokenTail = admission({ providerAgentId: "1", epoch: 3, catalogEpoch: 3,
        previousAdmissionHash: hash("f"), enabled: true });
      await expect(federation(pool, [next, brokenTail]).activateAdmissions())
        .rejects.toThrow("Servicing admission chain is invalid");
      // The valid first transition and deactivation of the prior row must both
      // roll back when the later transition fails inside the real transaction.
      expect(await snapshot()).toEqual(before);
      await federation(pool, [next]).activateAdmissions();
      await federation(pool, [next]).activateAdmissions();
      const after = await snapshot();
      expect(after).toHaveLength(2);
      expect(after.filter(row => row.current).map(row => row.hash))
        .toEqual([canonicalHash(next).slice(2)]);
      await expect(federation(pool, [active]).activateAdmissions())
        .rejects.toThrow("Current servicing admission is absent from the marketplace manifest");
      expect(await snapshot()).toEqual(after);
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
      await bootstrap.end();
    }
  }, 60_000);
});
