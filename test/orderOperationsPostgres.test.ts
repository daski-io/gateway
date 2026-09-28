import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { createPool, runMigrations } from "../src/db/pool.js";
import { StandardRailStore, type CreateDraftInput } from "../src/standardRail/store.js";
import { fulfillmentClock } from "../src/standardRail/operationsStore.js";
import type { OrderOperations } from "../src/standardRail/operationsSchema.js";
import { canonicalHash } from "../src/standardRail/canonical.js";

const databaseUrl = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const hash = (n: string) => `0x${n.repeat(64)}` as Hex;
const payer = (n: string) => `0x${n.repeat(40)}` as Hex;
const now = () => Math.floor(Date.now()/1000);
function draft(): CreateDraftInput {
  return {
    providerAgentId: "8327", outcomeId: "create-mailbox", bindingProfile: "recipe-bound-v2",
    listingManifestHash: hash("1"), providerOfferHash: hash("2"),
    listing: { purchaseReadiness: "payer_dns", deadlinePolicy: { minimumPaymentWindowSeconds: 30 } } as CreateDraftInput["listing"],
    quoteHash: hash("3"), quote: {} as CreateDraftInput["quote"], orderNonce: hash("4"),
    intentId: `int_${randomUUID()}`, canonicalRequestHash: hash("5"), canonicalRequest: {},
    grossAmount: "1000000", railEpoch: "1", listingEpoch: "1",
    expiresAt: new Date(Date.now()+60_000), expectedPayer: payer("a"),
  };
}
function observation(revision = 1): OrderOperations {
  return { schemaVersion: 1, revision, observedAt: now(), support: null, recovery: null,
    fulfillment: { phase: "dns_pending", reasons: ["dns_unverified"], pendingSince: now()-10,
      lastCheckedAt: now(), nextCheckAt: now()+300, accumulatedWaitSeconds: 10,
      missingRecords: [{ type: "TXT", name: "_daski-mail.private.example", value: "private-payer-proof", priority: null }] } };
}

describe("payer-bound drafts and durable provider observations", () => {
  it("expands prior schema, deduplicates concurrent payer drafts, preserves evidence and excludes only admitted waits", async () => {
    const schema = `gateway_operations_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 4 });
    try {
      await runMigrations(pool, { through: "048_dispatch_operator_recovery.sql" });
      // A row written by the prior runtime still reads after the additive migration.
      await pool.query(`INSERT INTO standard_orders(order_id,order_key,order_handle,handle_hash,state,provider_agent_id,
        outcome_id,binding_profile,listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
        canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,expires_at)
        VALUES ('legacy',$1,'legacy',$2,'CHALLENGE_ISSUED','7','legacy','stock-fixed-v1',$3,$4,'{}',$5,'{}',$6,'{}',$7,'int_11111111-1111-4111-8111-111111111111',100,1,1,now())`,
      [Buffer.alloc(32,1),Buffer.alloc(32,2),Buffer.alloc(32,3),Buffer.alloc(32,4),Buffer.alloc(32,5),Buffer.alloc(32,6),Buffer.alloc(32,7)]);
      await runMigrations(pool);
      const store = new StandardRailStore(pool);
      const createDraft = (input: CreateDraftInput) => store.createDraft({ ...input,
        orderNonce:canonicalHash(randomUUID()),intentId:`int_${randomUUID()}` });
      expect((await store.findById("legacy"))?.expectedPayer).toBeNull();
      const input = draft();
      const [first, second] = await Promise.all([createDraft(input), createDraft(input)]);
      expect(first.order.orderId).toBe(second.order.orderId);
      const other = await createDraft({ ...input, expectedPayer: payer("b") });
      expect(other.order.orderId).not.toBe(first.order.orderId);
      expect(await store.findOpenDraft(input.providerAgentId,input.outcomeId,input.canonicalRequestHash,
        input.listingManifestHash,input.providerOfferHash,input.railEpoch,payer("c"),30)).toBeNull();
      await pool.query("UPDATE standard_orders SET expires_at=now()+interval '10 seconds' WHERE order_id=$1",[first.order.orderId]);
      const fresh = await createDraft(input);
      expect(fresh.order.orderId).not.toBe(first.order.orderId);
      await expect(store.claimAuthorization({ orderId: fresh.order.orderId, expectedVersion: fresh.order.version,
        authorizationKey: hash("6"),payer: payer("b"),encryptedPayload: Buffer.from("test"),paymentPayloadHash: hash("7"),
        facilitatorProfileHash: hash("8"),capacityLimit: 10 })).rejects.toThrow("READINESS_PAYER_MISMATCH");

      const view = observation();
      await store.persistOperations(fresh.order.orderId,view,null);
      await store.persistOperations(fresh.order.orderId,view,null);
      const cached = await store.loadOperations(fresh.order.orderId);
      expect(cached?.operations.fulfillment?.missingRecords).toEqual([]);
      const stored = await pool.query("SELECT safe_projection::text FROM standard_order_operations WHERE order_id=$1",[fresh.order.orderId]);
      expect(stored.rows[0].safe_projection).not.toContain("private.example");
      // Concurrent reads can arrive out of order: an older signed observation is ignored, never an error.
      await expect(store.persistOperations(fresh.order.orderId,{ ...view,revision:0 },null)).resolves.toBeUndefined();
      await expect(store.persistOperations(fresh.order.orderId,{ ...view,observedAt:view.observedAt-1 },null)).resolves.toBeUndefined();
      expect((await store.loadOperations(fresh.order.orderId))?.operations).toMatchObject({ revision:1,observedAt:view.observedAt });
      await expect(store.persistOperations(fresh.order.orderId,{ ...view,support:{ reviewId:"r",status:"open",
        lastAcceptedRequest:{ requestId:"r1",messageId:"m1",acceptedAt:now() } } },null)).rejects.toThrow("revision_conflict");
      await expect(store.persistOperations(fresh.order.orderId,{ ...view,revision:2,observedAt:now()-301 },null)).rejects.toThrow("observation_stale");
      // An operator reply reaches the buyer in the live response; the gateway retains none of it.
      const replied: OrderOperations = { ...view, revision:2, support:{ reviewId:"r",status:"open",
        lastAcceptedRequest:{ requestId:"r1",messageId:"m1",acceptedAt:now() },
        lastReply:{ messageId:"m2",repliedAt:now(),message:"Private operator reply" } } };
      await store.persistOperations(fresh.order.orderId,replied,null);
      const withReply = await pool.query("SELECT safe_projection::text FROM standard_order_operations WHERE order_id=$1",[fresh.order.orderId]);
      expect(withReply.rows[0].safe_projection).not.toContain("Private operator reply");
      expect(withReply.rows[0].safe_projection).not.toContain("lastReply");
      expect((await store.loadOperations(fresh.order.orderId))?.operations.support).toEqual({ reviewId:"r",status:"open",
        lastAcceptedRequest:replied.support!.lastAcceptedRequest });
      await expect(store.persistOperations(fresh.order.orderId,{ ...replied,support:{ ...replied.support!,
        lastReply:{ ...replied.support!.lastReply!,message:"Changed reply" } } },null)).rejects.toThrow("revision_conflict");

      const terminal = { payload: { taskId:"task", state:"failed",completedAt:now()-5,resultHash:hash("e") },signature:"0x01" };
      const completed: OrderOperations = { ...view, revision:3, fulfillment:null,
        recovery:{ recoveryId:"recovery",reviewId:"review",state:"completed",startedAt:now()-3,completedAt:now(),resultHash:hash("f"),
          originalTerminal:{state:"failed",completedAt:now()-5,resultHash:hash("e")} } };
      await store.persistOperations(fresh.order.orderId,completed,terminal);
      expect((await store.loadOperations(fresh.order.orderId))?.originalTerminal).toEqual(terminal);
      expect((await store.loadOperations(fresh.order.orderId))?.accumulatedWaitSeconds).toBe(10);
      await expect(store.persistOperations(fresh.order.orderId,{ ...view,revision:4,
        fulfillment:{...view.fulfillment!,accumulatedWaitSeconds:0} },terminal)).rejects.toThrow("wait_clock_regressed");
      await expect(store.persistOperations(fresh.order.orderId,{ ...completed,revision:4 },
        {...terminal,payload:{...terminal.payload,resultHash:hash("d")}})).rejects.toThrow("original_terminal_changed");
      await expect(store.persistOperations(fresh.order.orderId,{ ...completed,revision:4,recovery:{...completed.recovery!,
        originalTerminal:{...completed.recovery!.originalTerminal,resultHash:hash("d")}} },terminal)).rejects.toThrow("terminal_binding_invalid");

      // Ten admitted DNS waits consume no active-execution capacity in new payment admission.
      for (let i=0;i<10;i++) {
        const held = await createDraft({ ...input,canonicalRequestHash:canonicalHash({i}) });
        await pool.query("INSERT INTO standard_capacity_reservations(order_id,listing_manifest_hash,state) VALUES ($1,$2,'open')",
          [held.order.orderId,Buffer.from(input.listingManifestHash.slice(2),"hex")]);
        await store.persistOperations(held.order.orderId,view,null);
      }
      const active = await createDraft({ ...input,canonicalRequestHash:hash("c") });
      await expect(store.claimAuthorization({ orderId:active.order.orderId,expectedVersion:active.order.version,
        authorizationKey:hash("6"),payer:payer("a"),encryptedPayload:Buffer.from("test"),paymentPayloadHash:hash("7"),
        facilitatorProfileHash:hash("8"),capacityLimit:10 })).resolves.toMatchObject({state:"ATTEMPT_OPENED"});
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
      await bootstrap.end();
    }
  },60_000);

  it("pauses only admitted waits, reports stale progress, and never adds replayed wait time twice", () => {
    const view=observation();
    expect(fulfillmentClock(view,true)).toMatchObject({waiting:true,stale:false,excludedSeconds:10});
    expect(fulfillmentClock(view,false)).toEqual({waiting:false,stale:false,excludedSeconds:0});
    expect(fulfillmentClock(view,true,now()+31*86400)).toMatchObject({waiting:true,stale:true,excludedSeconds:10});
    expect(fulfillmentClock(view,true).excludedSeconds).toBe(fulfillmentClock(view,true).excludedSeconds);
    view.fulfillment!.phase="provisioning";
    expect(fulfillmentClock(view,true)).toEqual({waiting:false,stale:false,excludedSeconds:10});
  });
});
