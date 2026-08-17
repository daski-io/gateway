import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.js";
import { CONFIRMATION_PREPARATION_INSERT_SQL } from "../src/standardRail/confirmations.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

describe("confirmation preparation against PostgreSQL", () => {
  it("binds the shared deadline parameter without an ambiguous type", async () => {
    const namespace = `confirmation_prepare_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${namespace}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: namespace, max: 1 });
    try {
      await pool.query(`CREATE TABLE standard_confirmation_preparations (
        preparation_id UUID PRIMARY KEY,
        order_id TEXT NOT NULL,
        order_key BYTEA NOT NULL,
        payer TEXT NOT NULL,
        operation TEXT NOT NULL,
        confirmation TEXT,
        current_uid BYTEA,
        transitions_used SMALLINT NOT NULL,
        eas_nonce NUMERIC(78,0) NOT NULL,
        deadline BIGINT NOT NULL,
        request_hash BYTEA NOT NULL,
        canonical_typed_data JSONB NOT NULL,
        final_transition_acknowledged BOOLEAN NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`);
      const deadline = "2000000000";
      await pool.query(CONFIRMATION_PREPARATION_INSERT_SQL, [
        randomUUID(), "ord-test", Buffer.alloc(32, 1),
        "0x1111111111111111111111111111111111111111", "attest-confirmation", "Confirmed",
        null, 0, "42", deadline, Buffer.alloc(32, 2), { primaryType: "Attest" }, false,
      ]);
      const result = await pool.query<{ deadline: string; expires_at: Date }>(
        "SELECT deadline::text,expires_at FROM standard_confirmation_preparations",
      );
      expect(result.rows[0]?.deadline).toBe(deadline);
      expect(result.rows[0]?.expires_at.toISOString()).toBe("2033-05-18T03:33:20.000Z");
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${namespace}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  });
});
