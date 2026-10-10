import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { createPool, runMigrations } from "../src/db/pool.js";
import { StandardRailStore, type CreateDraftInput } from "../src/standardRail/store.js";
import { canonicalHash } from "../src/standardRail/canonical.js";

const databaseUrl = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const hash = (n: string) => `0x${n.repeat(64)}` as Hex;
const schema = `gateway_settlement_lane_${randomUUID().replaceAll("-", "")}`;
const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 2 });
const store = new StandardRailStore(pool);

function draft(listingManifestHash: Hex): CreateDraftInput {
  return {
    providerAgentId: "8327", outcomeId: "register-domain", bindingProfile: "recipe-bound-v2",
    listingManifestHash, providerOfferHash: hash("2"),
    listing: { purchaseReadiness: "payer_dns", deadlinePolicy: { minimumPaymentWindowSeconds: 30 } } as CreateDraftInput["listing"],
    quoteHash: hash("3"), quote: {} as CreateDraftInput["quote"], orderNonce: canonicalHash(randomUUID()),
    intentId: `int_${randomUUID()}`, canonicalRequestHash: canonicalHash(randomUUID()), canonicalRequest: {},
    grossAmount: "17990000", railEpoch: "1", listingEpoch: "1",
    expiresAt: new Date(Date.now() + 180_000), expectedPayer: `0x${"a".repeat(40)}` as Hex,
  };
}

/** An order of `listing` in `state`, last updated `secondsAgo`. */
async function seeded(listing: Hex, state: string, {
  secondsAgo = 600, authorized = false, released = false,
}: { secondsAgo?: number; authorized?: boolean; released?: boolean } = {}): Promise<string> {
  const { order } = await store.createDraft(draft(listing));
  await pool.query(
    `UPDATE standard_orders SET state=$2,updated_at=now()-($3*interval '1 second'),
       authorization_key=CASE WHEN $4 THEN $5::bytea ELSE authorization_key END,
       release_evidence_hash=CASE WHEN $6 THEN $7::bytea ELSE release_evidence_hash END
     WHERE order_id=$1`,
    [order.orderId, state, secondsAgo, authorized, randomBytes(32), released, randomBytes(32)],
  );
  return order.orderId;
}

async function lease(lane: "all" | "settlement", skipped: string[] = []): Promise<string | null> {
  const leased = await store.leaseRecoverable("worker", 30, skipped, lane);
  if (!leased) return null;
  await store.releaseLease(leased.orderId, "worker", leased.leaseFence);
  return leased.orderId;
}

beforeAll(async () => {
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations(pool);
}, 60_000);
afterAll(async () => {
  await pool.end();
  await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
  await bootstrap.end();
});

describe("orders of one listing settle side by side", () => {
  it("never waits for another order mid-settlement, only for a legal hold that never proved its release", async () => {
    const listing = hash("4");
    const mine = await seeded(listing, "VERIFIED", { authorized: true });
    for (const state of ["SETTLE_INVOKED", "FACILITATOR_CONFIRMED", "SETTLEMENT_AMBIGUOUS", "SETTLEMENT_FAILED",
      "EXTERNAL_OR_UNPROVEN_DEPOSIT", "DEPOSIT_FINAL", "RELEASE_FINAL", "DISPATCHED"]) {
      await seeded(listing, state, { authorized: true });
    }
    expect(await store.listingSettlementFrozen(listing, mine)).toBe(false);
    await seeded(listing, "LEGAL_HOLD", { authorized: true, released: true });
    await seeded(listing, "LEGAL_HOLD");
    expect(await store.listingSettlementFrozen(listing, mine)).toBe(false);
    const held = await seeded(listing, "LEGAL_HOLD", { authorized: true });
    expect(await store.listingSettlementFrozen(listing, mine)).toBe(true);
    expect(await store.listingSettlementFrozen(hash("5"), mine)).toBe(false);
    expect(await store.listingSettlementFrozen(listing, held)).toBe(false);
    // The rest of this file leases recovery work; these orders are done.
    await pool.query("UPDATE standard_orders SET state='FULFILLED'");
  });

  it("recovers a claimed or verified authorization after five seconds, ahead of older work, and alone on the settlement lane", async () => {
    const listing = hash("6");
    const dispatched = await seeded(listing, "DISPATCHED", { secondsAgo: 7_200 });
    const verified = await seeded(listing, "VERIFIED", { secondsAgo: 3, authorized: true });
    expect(await lease("settlement")).toBeNull();
    await pool.query("UPDATE standard_orders SET updated_at=now()-interval '6 seconds' WHERE order_id=$1", [verified]);
    expect(await lease("all")).toBe(verified);
    expect(await lease("all", [verified])).toBe(dispatched);
    expect(await lease("settlement")).toBe(verified);
    expect(await lease("settlement", [verified])).toBeNull();
    const opened = await seeded(listing, "ATTEMPT_OPENED", { secondsAgo: 6, authorized: true });
    expect(await lease("settlement", [verified])).toBe(opened);
  });
});
