import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPool, runMigrations } from "../src/db/pool.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

describe("gateway migrations", () => {
  it("builds the complete schema from an empty database namespace", async () => {
    const schema = `gateway_migrations_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({
      connectionString: databaseUrl,
      searchPath: `${schema},public`,
      max: 1,
    });
    try {
      await runMigrations(pool);
      await runMigrations(pool);

      const migrationCount = readdirSync(
        new URL("../src/db/migrations", import.meta.url),
      ).filter((name) => name.endsWith(".sql")).length;
      const applied = await pool.query<{ count: number; checksums: number }>(
        "SELECT count(*)::int AS count, count(checksum)::int AS checksums FROM _migrations",
      );
      expect(applied.rows[0]).toEqual({
        count: migrationCount,
        checksums: migrationCount,
      });

      await pool.query(
        `INSERT INTO standard_rail_artifacts
          (artifact_hash,artifact_type,schema_version,environment,chain_id,canonical_json,valid_before)
         VALUES ($1,'ListingCommitmentV2',2,'sandbox',84532,'{}',now() + interval '1 hour')`,
        [Buffer.alloc(32, 2)],
      );
      await expect(
        pool.query(
          `INSERT INTO standard_rail_artifacts
            (artifact_hash,artifact_type,schema_version,environment,chain_id,canonical_json,valid_before)
           VALUES ($1,'FutureArtifactV3',3,'sandbox',84532,'{}',now() + interval '1 hour')`,
          [Buffer.alloc(32, 3)],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const versions = await pool.query<{ schema_version: number }>(
        "SELECT schema_version FROM standard_rail_artifacts ORDER BY schema_version",
      );
      expect(versions.rows).toEqual([{ schema_version: 2 }]);
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  }, 60_000);
});

it("waits for the migration advisory lock beyond the pool lock timeout and applies one shared startup budget",async()=>{
 const schema="gateway_migration_wait_"+randomUUID().replaceAll("-","");
 const admin=createPool({connectionString:databaseUrl,max:2});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=createPool({connectionString:databaseUrl,searchPath:schema+",public",max:1,lockTimeoutMs:50});
 const holder=await admin.connect();
 try{
  await runMigrations(pool,{through:"055_commerce_revision_atomicity.sql"});
  await holder.query("SELECT pg_advisory_lock(hashtextextended($1,0))",["daski-gateway:migrations"]);
  const migrating=runMigrations(pool,{timeoutMs:5_000});
  const outcome=migrating.then(()=>null,error=>error);
  await new Promise(resolve=>setTimeout(resolve,200));
  await holder.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",["daski-gateway:migrations"]);
  expect(await outcome).toBeNull();
 }finally{
  await holder.query("SELECT pg_advisory_unlock_all()");holder.release();
  await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();
 }
},15_000);

it("counts advisory-lock waiting and all migration batches against the same deadline",async()=>{
 const schema="gateway_migration_budget_"+randomUUID().replaceAll("-","");
 const admin=createPool({connectionString:databaseUrl,max:3});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=createPool({connectionString:databaseUrl,searchPath:schema+",public",max:1,lockTimeoutMs:50});
 const holder=await admin.connect(), ddl=await admin.connect();
 try{
  await runMigrations(pool,{through:"055_zz"});
  await ddl.query("BEGIN");
  await ddl.query('LOCK TABLE "'+schema+'".standard_orders IN ACCESS SHARE MODE');
  await holder.query("SELECT pg_advisory_lock(hashtextextended($1,0))",["daski-gateway:migrations"]);
  const started=Date.now();
  const outcome=runMigrations(pool,{timeoutMs:450}).then(()=>null,error=>error);
  await new Promise(resolve=>setTimeout(resolve,250));
  await holder.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",["daski-gateway:migrations"]);
  expect(await outcome).toBeInstanceOf(Error);
  expect(Date.now()-started).toBeLessThan(1_000);
  expect((await pool.query("SELECT count(*)::int AS n FROM _migrations WHERE name >= '056_'")).rows[0].n).toBe(0);
 }finally{
  await holder.query("SELECT pg_advisory_unlock_all()");holder.release();
  await ddl.query("ROLLBACK");ddl.release();
  await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();
 }
},15_000);
