import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.js";
import type { Hex } from "../src/types.js";
import type { EvidenceResult } from "../src/standardRail/evidence.js";
import { StandardRailJournal } from "../src/standardRail/journal.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

const hash = (digit: string): Hex => `0x${digit.repeat(64)}` as Hex;

function evidence(evidenceHash: Hex, transactionHash: Hex, logIndex: number): EvidenceResult {
  return {
    evidenceHash,
    transactionHash,
    blockNumber: 100n,
    blockHash: hash("f"),
    transactionIndex: 1,
    logIndex,
    sources: ["rpc-a.example", "rpc-b.example"],
    canonicalEvidence: { evidenceHash },
  };
}

function locatorIndexSql(): string {
  const migration = readFileSync(
    new URL("../src/db/migrations/032_standard_rail_hardening.sql", import.meta.url),
    "utf8",
  );
  const statement = migration.match(
    /CREATE UNIQUE INDEX standard_chain_evidence_locator_unique_idx[\s\S]*?;/,
  )?.[0];
  if (!statement) throw new Error("standard evidence locator index is missing");
  return statement;
}

describe("standard evidence locator migration", () => {
  it("admits shared releases but rejects reused deposit locators", async () => {
    const schema = `standard_evidence_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: schema, max: 1 });
    const journal = new StandardRailJournal(pool);
    try {
      await pool.query(`CREATE TABLE standard_chain_evidence (
        evidence_hash BYTEA PRIMARY KEY,
        order_id TEXT NOT NULL,
        evidence_kind TEXT NOT NULL,
        chain_id BIGINT NOT NULL,
        block_number BIGINT NOT NULL,
        block_hash TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        transaction_index INTEGER NOT NULL,
        log_index INTEGER NOT NULL,
        source_fingerprints JSONB NOT NULL,
        canonical_evidence JSONB NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query(locatorIndexSql());

      const releaseTransaction = hash("a");
      await journal.recordEvidence("order-release-a", "release", evidence(hash("1"), releaseTransaction, 7), 84532);
      await journal.recordEvidence("order-release-b", "release", evidence(hash("2"), releaseTransaction, 7), 84532);
      const releases = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM standard_chain_evidence WHERE evidence_kind='release'",
      );
      expect(releases.rows[0]?.count).toBe(2);

      const depositTransaction = hash("b");
      await journal.recordEvidence("order-deposit-a", "deposit", evidence(hash("3"), depositTransaction, 3), 84532);
      await expect(journal.recordEvidence(
        "order-deposit-b",
        "deposit",
        evidence(hash("4"), depositTransaction, 3),
        84532,
      )).rejects.toMatchObject({ code: "23505" });

    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  });
});
