import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool, runMigrations } from "../src/db/pool.js";
import { ReleaseSales } from "../src/standardRail/releaseSales.js";
import { StandardRailStore } from "../src/standardRail/store.js";
import { StandardRailJournal } from "../src/standardRail/journal.js";

const databaseUrl = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const serviceId = `0x${"ab".repeat(32)}`;
const listingManifestHash = `0x${"03".repeat(32)}`;
const scope = { providerAgentId: "7", serviceId, listingManifestHash };
describe("durable scoped stop-sale", () => {
  it("admits a purchase after another order settles on the same listing without an ordinary guard write", async () => {
    const schema = "release_claim_"+randomUUID().replaceAll("-", "");
    const admin=createPool({connectionString:databaseUrl,max:1});
    await admin.query('CREATE SCHEMA "'+schema+'"');
    const pool=createPool({connectionString:databaseUrl,searchPath:schema+",public",max:4});
    try {
      await runMigrations(pool);
      for(const [index,id,state] of [[1,"settling","VERIFIED"],[2,"claiming","CHALLENGE_ISSUED"]] as const) {
        await pool.query(`INSERT INTO standard_orders
          (order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
          listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
          canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,expires_at)
          VALUES($1,$2,$1,$2,$3,'7','outcome','recipe-bound-v2',$4,$2,$5,$2,'{}',$2,'{}',$2,$6,1000000,1,1,now()+interval '1 hour')`,
          [id,Buffer.alloc(32,index),state,Buffer.alloc(32,3),{commitment:{payload:{serviceId}}},
           "int_"+randomUUID()]);
      }
      await pool.query("INSERT INTO standard_settlement_attempts(order_id,attempt_id,facilitator_profile_hash) VALUES('settling','old-attempt',$1)",[Buffer.alloc(32,8)]);
      let interleaved=false;
      const wrapped={connect:async()=>{
        const client=await pool.connect();
        return {release:()=>client.release(),query:async(sql:string,values?:unknown[])=>{
          const result=await client.query(sql,values);
          if(sql.startsWith("SELECT listing_manifest_hash,expected_payer")) {
            // The claim already has a SERIALIZABLE snapshot. The other order's
            // legacy settle UPDATE must not invalidate it.
            interleaved=true;
            expect(await new StandardRailJournal(pool).markSettleInvoked("settling")).toBe(true);
          }
          return result;
        }};
      }};
      const claimed=await new StandardRailStore(wrapped as never).claimAuthorization({
        orderId:"claiming",expectedVersion:0,authorizationKey:"0x"+"09".repeat(32) as never,
        payer:"0x2222222222222222222222222222222222222222",encryptedPayload:Buffer.from("original"),
        paymentPayloadHash:"0x"+"0a".repeat(32) as never,facilitatorProfileHash:"0x"+"08".repeat(32) as never,capacityLimit:10,
      });
      expect(interleaved).toBe(true);
      expect(claimed.state).toBe("ATTEMPT_OPENED");
      expect((await pool.query("SELECT generation::int FROM standard_release_serialization_guards WHERE guard_key=$1",
        ["release-sale:"+"03".repeat(32)])).rows[0].generation).toBe(1);
    } finally {await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();}
  },60_000);

  it("serializes stop with settlement admission across replicas and preserves captured work", async () => {
    const schema = `release_sales_${randomUUID().replaceAll("-", "")}`;
    const admin = createPool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 4 });
    try {
      await runMigrations(pool);
      await pool.query(`INSERT INTO standard_orders
        (order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
         listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
         canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,
         expires_at,payer,encrypted_payment_payload)
        VALUES ('parked',$1,'handle',$2,'VERIFIED','7','outcome','recipe-bound-v2',
          $3,$4,$5,$6,'{}',$7,'{}',$8,'int_12345678-1234-4123-8123-123456789abc',1000000,1,1,
          now()+interval '1 hour','0x2222222222222222222222222222222222222222',$9)`,
        [Buffer.alloc(32,1),Buffer.alloc(32,2),Buffer.alloc(32,3),Buffer.alloc(32,4),
          { commitment: { payload: { serviceId } } },Buffer.alloc(32,5),Buffer.alloc(32,6),Buffer.alloc(32,7),Buffer.from("captured")]);
      await pool.query(`INSERT INTO standard_settlement_attempts(order_id,attempt_id,facilitator_profile_hash)
        VALUES ('parked','attempt', $1)`, [Buffer.alloc(32,8)]);
      const first = new ReleaseSales(pool);
      const second = new ReleaseSales(pool);
      await expect(first.set({ ...scope, serviceId: "0x" + "cd".repeat(32),
        requestId: "wrong-scope-1", expectedRevision: 0, acceptingNewOrders: false })).rejects.toThrow("SALE_SCOPE_NOT_FOUND");
      expect((await pool.query("SELECT * FROM standard_sale_controls")).rows).toEqual([]);
      expect((await pool.query("SELECT * FROM standard_parked_authorizations")).rows).toEqual([]);
      const stopped = await first.set({ ...scope, requestId: "stop-listing-1", expectedRevision: 0, acceptingNewOrders: false });
      expect(stopped).toMatchObject({ revision: 1, requestId: "stop-listing-1", acceptingNewOrders: false });
      await expect(second.set({ ...scope, requestId: "stop-listing-1", expectedRevision: 0, acceptingNewOrders: false }))
        .resolves.toEqual(stopped);
      // The original UPDATE is exactly what the legacy journal used: the
      // database itself must enforce the fence, not only new application code.
      await expect(pool.query("UPDATE standard_settlement_attempts SET settle_invoked_at=now() WHERE order_id='parked'"))
        .rejects.toThrow("SALE_SUSPENDED");
      await expect(new StandardRailJournal(pool).markSettleInvoked("parked")).rejects.toThrow("SALE_SUSPENDED");
      expect(await second.isParked("parked")).toBe(true);
      await expect(pool.query("UPDATE standard_orders SET state='NOT_SETTLED',encrypted_payment_payload=NULL WHERE order_id='parked'"))
        .rejects.toThrow("PARKED_AUTHORIZATION_FINALITY_REQUIRED");
      expect((await pool.query("SELECT state,encrypted_payment_payload FROM standard_orders WHERE order_id='parked'")).rows[0])
        .toMatchObject({ state: "VERIFIED", encrypted_payment_payload: Buffer.from("captured") });
      await second.set({ ...scope, requestId: "resume-listing-1", expectedRevision: 1, acceptingNewOrders: true });
      // Resume permits fresh sales but never silently submits an authorization
      // whose submission was stopped under an earlier revision.
      await expect(new StandardRailJournal(pool).markSettleInvoked("parked")).rejects.toThrow("AUTHORIZATION_PARKED");
      await expect(second.set({ ...scope, requestId: "bad-cas-1", expectedRevision: 1, acceptingNewOrders: false }))
        .rejects.toThrow("SALE_REVISION_CONFLICT");
    } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
  }, 60_000);
});
