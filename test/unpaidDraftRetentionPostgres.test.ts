import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { createPool, runMigrations } from "../src/db/pool.js";
import { createRateLimitQueries } from "../src/db/rateLimitQueries.js";
import { StandardRailStore, type CreateDraftInput } from "../src/standardRail/store.js";
import type { StandardListing } from "../src/standardRail/types.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;

function draft(nonceByte: string): CreateDraftInput {
  return {
    providerAgentId: "8327",
    outcomeId: "form-entity",
    bindingProfile: "stock-fixed-v1",
    listingManifestHash: hash("1"),
    providerOfferHash: hash("2"),
    listing: { placeholder: true } as unknown as StandardListing,
    quoteHash: hash("3"),
    quote: { placeholder: true } as unknown as CreateDraftInput["quote"],
    orderNonce: hash(nonceByte),
    intentId: `int_${randomUUID()}`,
    canonicalRequestHash: hash(nonceByte === "a" ? "4" : "5"),
    canonicalRequest: { nonce: nonceByte },
    grossAmount: "1000000",
    railEpoch: "1",
    listingEpoch: "1",
    expiresAt: new Date(Date.now() + 600_000),
  };
}

describe("retention of unpaid drafts and rate-limit buckets", () => {
  it("deletes expired never-claimed drafts and keeps every order that carried an authorization", async () => {
    const schema = `gateway_retention_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 2 });
    try {
      await runMigrations(pool);
      const store = new StandardRailStore(pool);
      const unpaid = await store.createDraft(draft("a"));
      const paid = await store.createDraft(draft("b"));
      await pool.query(
        `UPDATE standard_orders SET state='NOT_SETTLED', updated_at=now()-interval '2 days'
          WHERE order_id=$1`,
        [unpaid.order.orderId],
      );
      await pool.query(
        `UPDATE standard_orders SET state='NOT_SETTLED', updated_at=now()-interval '2 days',
                authorization_key=$2, payer='0x2222222222222222222222222222222222222222'
          WHERE order_id=$1`,
        [paid.order.orderId, Buffer.alloc(32, 9)],
      );
      // A draft that expired recently is still inside the retention window.
      const recent = await store.createDraft({ ...draft("c"), canonicalRequestHash: hash("6") });
      await pool.query(
        "UPDATE standard_orders SET state='NOT_SETTLED', updated_at=now()-interval '1 hour' WHERE order_id=$1",
        [recent.order.orderId],
      );

      await expect(store.pruneUnpaidDrafts()).resolves.toBe(1);
      const remaining = await pool.query<{ order_id: string }>(
        "SELECT order_id FROM standard_orders ORDER BY created_at",
      );
      expect(remaining.rows.map((row) => row.order_id)).toEqual([paid.order.orderId, recent.order.orderId]);
      const transitions = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM standard_order_transitions WHERE order_id=$1",
        [unpaid.order.orderId],
      );
      expect(transitions.rows[0]).toEqual({ count: 0 });
      await expect(store.pruneUnpaidDrafts()).resolves.toBe(0);

      const rateLimits = createRateLimitQueries(pool);
      await rateLimits.consumeRateLimitBucket("payment-resource:203.0.113.9", 60_000);
      await pool.query(
        `INSERT INTO rate_limit_buckets (bucket_key, window_started_at, request_count)
         VALUES ('payment-resource:198.51.100.7', now() - interval '1 hour', 3)`,
      );
      await expect(rateLimits.pruneRateLimitBuckets()).resolves.toBe(1);
      const buckets = await pool.query<{ bucket_key: string }>("SELECT bucket_key FROM rate_limit_buckets");
      expect(buckets.rows).toEqual([{ bucket_key: "payment-resource:203.0.113.9" }]);
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  }, 60_000);
});
