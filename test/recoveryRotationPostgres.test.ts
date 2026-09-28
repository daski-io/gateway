import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { createPool, runMigrations } from "../src/db/pool.js";
import { StandardRailStore, type CreateDraftInput } from "../src/standardRail/store.js";
import { canonicalHash } from "../src/standardRail/canonical.js";

const databaseUrl = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const hash = (n: string) => `0x${n.repeat(64)}` as Hex;
const schema = `gateway_recovery_rotation_${randomUUID().replaceAll("-", "")}`;
const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 2 });
const store = new StandardRailStore(pool);

function draft(): CreateDraftInput {
  return {
    providerAgentId: "8327", outcomeId: "create-mailbox", bindingProfile: "recipe-bound-v2",
    listingManifestHash: hash("1"), providerOfferHash: hash("2"),
    listing: { purchaseReadiness: "payer_dns", deadlinePolicy: { minimumPaymentWindowSeconds: 30 } } as CreateDraftInput["listing"],
    quoteHash: hash("3"), quote: {} as CreateDraftInput["quote"], orderNonce: canonicalHash(randomUUID()),
    intentId: `int_${randomUUID()}`, canonicalRequestHash: canonicalHash(randomUUID()), canonicalRequest: {},
    grossAmount: "1000000", railEpoch: "1", listingEpoch: "1",
    expiresAt: new Date(Date.now() + 60_000), expectedPayer: `0x${"a".repeat(40)}` as Hex,
  };
}

/** A dispatched order whose provider polls change nothing, as a long DNS wait does. */
async function waiting(ageMinutes: number): Promise<string> {
  const { order } = await store.createDraft(draft());
  await pool.query(`UPDATE standard_orders SET state='DISPATCHED',updated_at=now()-($2*interval '1 minute')
    WHERE order_id=$1`, [order.orderId, ageMinutes]);
  return order.orderId;
}

async function visit(skipped: string[] = []): Promise<string | null> {
  const leased = await store.leaseRecoverable("worker", 30, skipped);
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

describe("recovery rotation", () => {
  it("visits every recoverable order before any repeats, although polls change nothing", async () => {
    const orders = [await waiting(60), await waiting(50), await waiting(40)];
    const firstRound = [await visit(), await visit(), await visit()];
    expect(firstRound).toEqual(orders);
    // A batch that stopped after one order still leaves the others their turn.
    expect(await visit()).toBe(orders[0]);
    expect(await visit()).toBe(orders[1]);
  });

  it("serves a never-checked order ahead of long waits already in rotation", async () => {
    const fresh = await waiting(2);
    expect(await visit()).toBe(fresh);
  });
});
