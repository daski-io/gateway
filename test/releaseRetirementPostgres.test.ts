import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { ReleaseRetirements, RetirementBlocked } from "../src/standardRail/releaseRetirements.js";
import { artifactPayloadHash } from "../src/standardRail/canonical.js";
import { ReleaseSales } from "../src/standardRail/releaseSales.js";

const databaseUrl = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const h = (n: number) => "0x" + Buffer.alloc(32,n).toString("hex");
const serviceId=h(4), listingManifestHash=h(3);
const scope={kind:"listing" as const,providerAgentId:"7",serviceId,listingManifestHash};
const privateKey=("0x"+"11".repeat(32)) as Hex;
const signing={environment:"test",chainId:84532,privateKey,providerAudience:()=>"https://provider.test"};
let admin: Pool, pool: Pool, schema: string, api: ReleaseRetirements;
beforeEach(async()=>{
  schema="retirement_"+randomUUID().replaceAll("-","");
  admin=createPool({connectionString:databaseUrl,max:1});
  await admin.query('CREATE SCHEMA "'+schema+'"');
  pool=createPool({connectionString:databaseUrl,searchPath:schema+",public",max:6});
  await runMigrations(pool);
  api=new ReleaseRetirements(pool,signing);
});
afterEach(async()=>{
  await pool?.end();await admin?.query('DROP SCHEMA "'+schema+'" CASCADE');await admin?.end();
});
async function order(id="old", state="NOT_SETTLED", hash=listingManifestHash, index=1, db: Pick<Pool,"query">=pool) {
  await db.query(`INSERT INTO standard_orders
    (order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
    listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
    canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,expires_at)
    VALUES($1,$2,$1,$2,$3,'7','outcome','recipe-bound-v2',$4,$2,$5,$2,'{}',$2,'{}',$2,$6,1000000,1,1,now()-interval '1 day')`,
    [id,Buffer.alloc(32,index),state,Buffer.from(hash.slice(2),"hex"),{commitment:{payload:{serviceId}}},"int_"+randomUUID()]);
}
const pending=async()=> {
  const result=await api.state(scope);
  expect(result.retired).toBe(false);
  return result.blockers;
};

describe("contract retirement durable proof",()=>{
  it("issues a verifiable immutable receipt, supports retries, and fences old SQL admissions without hiding history",async()=>{
    await order();
    expect(Object.values(await pending()).every(count=>count===0)).toBe(true);
    const result=await api.retire({...scope,requestId:"retire-listing-1"});
    expect(result).toMatchObject({scope,retired:true,blockers:{},requestId:"retire-listing-1",receipt:{artifactType:"GatewayContractRetirementV1",
      audience:"https://provider.test",payload:{scope,requestId:"retire-listing-1"}}});
    const {signature,...unsigned}=result.receipt;
    expect(await recoverMessageAddress({message:{raw:artifactPayloadHash(unsigned)},signature}))
      .toBe(privateKeyToAccount(privateKey).address);
    expect((await api.retire({...scope,requestId:"retire-listing-again"})).receipt.payload).toEqual(result.receipt.payload);
    await expect(api.retire({...scope,requestId:"retire-listing-1",serviceId:h(5)})).rejects.toThrow("RETIREMENT_REQUEST_ID_REUSED");
    await expect(order("new","DRAFT",listingManifestHash,2)).rejects.toThrow("CONTRACT_RETIRED");
    await expect(pool.query("UPDATE standard_orders SET state='ATTEMPT_OPENED' WHERE order_id='old'")).rejects.toThrow("CONTRACT_RETIRED");
    await expect(pool.query("UPDATE standard_orders SET updated_at=now() WHERE order_id='old'")).resolves.toBeDefined();
    await expect(pool.query("DELETE FROM standard_contract_retirements")).rejects.toThrow("CONTRACT_RETIREMENT_IMMUTABLE");
    await expect(new ReleaseSales(pool).set({...scope,requestId:"reopen-retired",expectedRevision:0,acceptingNewOrders:true})).rejects.toThrow("CONTRACT_RETIRED");
    await expect(pool.query("INSERT INTO standard_parked_authorizations(order_id,sale_revision) VALUES('old',1)"))
      .rejects.toThrow("CONTRACT_RETIRED");
    expect(await api.inventory()).toEqual([result.receipt.payload]);
  },60_000);

  it("retains failed and ambiguous work and independently checks parked and externally relayable authorizations",async()=>{
    await order("failed","PROVIDER_FAILED");
    expect(await pending()).toMatchObject({openOrders:1});
    await expect(api.retire({...scope,requestId:"failed-retirement"})).rejects.toBeInstanceOf(RetirementBlocked);
    await pool.query("UPDATE standard_orders SET state='NOT_SETTLED',authorization_key=$1,encrypted_payment_payload=$2 WHERE order_id='failed'",
      [Buffer.alloc(32,15),Buffer.from("encrypted")]);
    await pool.query("INSERT INTO standard_parked_authorizations(order_id,sale_revision) VALUES('failed',1)");
    expect(await pending()).toMatchObject({unresolvedAuthorizations:1,parkedAuthorizations:1});
    await pool.query("UPDATE standard_parked_authorizations SET finality_evidence='{}' WHERE order_id='failed'");
    await pool.query("UPDATE standard_orders SET encrypted_payment_payload=NULL WHERE order_id='failed'");
    expect(await pending()).toMatchObject({unresolvedAuthorizations:1});
    await pool.query("INSERT INTO standard_order_transitions(order_id,from_state,to_state,reason_code,fence) VALUES('failed','VERIFIED','NOT_SETTLED','parked_authorization_finalized_unpaid',0)");
    expect(await pending()).toMatchObject({unresolvedAuthorizations:0,parkedAuthorizations:0});
    await pool.query(`INSERT INTO standard_confirmation_preparations_v2
      (order_id,order_key,payer,operation,submissions_used,eas_nonce,deadline,request_hash,canonical_typed_data,
       final_transition_acknowledged,expires_at,profile_id,signed_deadline,profile_observation,authorization_group)
      VALUES('failed',$1,'0x2222222222222222222222222222222222222222','attest-confirmation',0,0,1,$2,'{}',
       false,now()-interval '1 day','eas-native-1.0.1',NULL,'{}',$3)`,[Buffer.alloc(32,1),Buffer.alloc(32,9),randomUUID()]);
    expect(await pending()).toMatchObject({relayableReviewAuthorizations:1});
    await expect(api.retire({...scope,requestId:"signed-auth-live"})).rejects.toBeInstanceOf(RetirementBlocked);
  },60_000);

  it("rejects a stale SERIALIZABLE legacy writer after the fence commits",async()=>{
    await order();
    const legacy=await pool.connect();
    try {
      await legacy.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await legacy.query("SELECT * FROM standard_orders WHERE order_id='old'");
      await api.retire({...scope,requestId:"serial-retirement"});
      await expect(legacy.query("UPDATE standard_orders SET state='ATTEMPT_OPENED' WHERE order_id='old'")).rejects.toMatchObject({code:"40001"});
    } finally {await legacy.query("ROLLBACK");legacy.release();}
  },60_000);

  it.each(["NOT_SETTLED","FULFILLED"])("waits for an in-flight %s journal write and refuses its unresolved obligation",async state=>{
    await order("old",state);
    if(state==="FULFILLED"){
      await pool.query("UPDATE standard_orders SET deposit_evidence_hash=$1,release_evidence_hash=$1 WHERE order_id='old'",[Buffer.alloc(32,9)]);
      await pool.query("INSERT INTO standard_rail_receipts(order_id,receipt_hash,canonical_receipt) VALUES('old',$1,'{}')",[Buffer.alloc(32,9)]);
    }
    const writer=await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(`INSERT INTO standard_reputation_operations(order_id,kind,logical_key,intent_hash,canonical_intent,state)
        VALUES('old','register',$1,$1,'{}','pending')`,[Buffer.alloc(32,8)]);
      let completed=false;
      const retirement=api.retire({...scope,requestId:"journal-race"}).finally(()=>{completed=true;});
      const outcome=retirement.catch(error=>error);
      await new Promise(resolve=>setTimeout(resolve,50));
      expect(completed).toBe(false);
      await writer.query("COMMIT");
      expect(await outcome).toBeInstanceOf(RetirementBlocked);
      expect((await pending()).reputationOperations).toBe(1);
    } finally {await writer.query("ROLLBACK");writer.release();}
  },60_000);

  it("rejects admission waiting behind retirement while unrelated contracts continue",async()=>{
    await order();
    let waiting: Promise<unknown>|undefined, unrelated=false;
    const wrapped={connect:async()=>{
      const client=await pool.connect();
      return {release:()=>client.release(),query:async(sql:string,values?:unknown[])=>{
        const result=await client.query(sql,values);
        if(sql.startsWith("INSERT INTO standard_contract_retirements(")) {
          waiting=order("late","DRAFT",listingManifestHash,2).catch(error=>error);
          await order("unrelated","DRAFT",h(9),3);
          unrelated=true;
        }
        return result;
      }};
    }};
    await new ReleaseRetirements(wrapped as Pool,signing).retire({...scope,requestId:"admission-race"});
    expect(unrelated).toBe(true);
    expect(await waiting).toMatchObject({message:"CONTRACT_RETIRED"});
  },60_000);
});

async function registration(state="SUPERSEDED") {
  const id=randomUUID();
  await pool.query(`INSERT INTO standard_service_registrations
    (registration_id,provider_agent_id,service_id,service_slug,service_version,agent_card_url,
     service_wallet,provider_owner,provider_agent_wallet,provider_signer,idempotency_key,provider_payee,
     registration_nonce,request_hash,canonical_intent,prepared_json,card_json,card_hash,skill_contract_set_hash,
     state,marketplace_enabled,card_accepting_orders)
     VALUES($1,'7',$2,'service','1','https://provider.test',$3,$3,$3,$3,$4,$3,$5,$5,'{}','{}','{}',$5,$5,$6,true,true)`,
    [id,Buffer.alloc(32,4),"0x"+"22".repeat(20),randomUUID(),Buffer.alloc(32,8),state]);
  await pool.query(`INSERT INTO standard_service_listings
    (listing_id,registration_id,listing_key,skill_id,skill_contract_hash,payment_required,accepting_new_orders,
     deployment_required,state,runtime_commitment_hash)
     VALUES($1,$2,$3,'old-skill',$3,false,false,false,'ACTIVE',$4)`,
    [randomUUID(),id,Buffer.alloc(32,8),Buffer.alloc(32,3)]);
  return id;
}
it("requires superseded registration and prevents old registration or listing reactivation",async()=>{
  const id=await registration("ACTIVE");
  expect((await pending()).activeRegistrations).toBe(1);
  await expect(api.retire({...scope,requestId:"active-retirement"})).rejects.toBeInstanceOf(RetirementBlocked);
  await pool.query("UPDATE standard_service_registrations SET state='SUPERSEDED' WHERE registration_id=$1",[id]);
  await api.retire({...scope,requestId:"inactive-retirement"});
  await expect(pool.query("UPDATE standard_service_registrations SET state='ACTIVE' WHERE registration_id=$1",[id])).rejects.toThrow("CONTRACT_RETIRED");
  await expect(pool.query("UPDATE standard_service_listings SET state='ACTIVE' WHERE registration_id=$1",[id])).rejects.toThrow("CONTRACT_RETIRED");
},60_000);

const assetScope={kind:"asset-action" as const,providerAgentId:"7",serviceId,actionDefinitionHash:h(12)};
async function catalog(epoch:number, actions:unknown[]) {
  const catalogHash=Buffer.alloc(32,20+epoch);
  const envelope={payload:{providerAgentId:"7",actionCatalogEpoch:epoch,actions}};
  await pool.query(`INSERT INTO standard_rail_artifacts
    (artifact_hash,artifact_type,schema_version,environment,chain_id,canonical_json,valid_before)
    VALUES($1,'ProviderAssetActionCatalogV1',1,'test',84532,$2,now()+interval '1 day')`,[catalogHash,envelope]);
  return catalogHash;
}
async function admission(epoch:number,catalogHash:Buffer) {
  await pool.query("UPDATE standard_provider_servicing_admissions SET current=false WHERE provider_agent_id='7'");
  if(epoch>1) await pool.query(`INSERT INTO standard_asset_action_targets(provider_agent_id,target_epoch)
    VALUES('7',$1) ON CONFLICT(provider_agent_id) DO UPDATE SET target_epoch=excluded.target_epoch`,[epoch]);
  await pool.query(`INSERT INTO standard_provider_servicing_admissions
    (provider_agent_id,admission_hash,profile_hash,canonical_admission,current,valid_before)
    VALUES('7',$1,$1,$2,true,now()+interval '1 day')`,
    [Buffer.alloc(32,30+epoch),{payload:{actionCatalogHash:"0x"+catalogHash.toString("hex"),actionCatalogEpoch:epoch,servicingProfileEpoch:epoch}}]);
}
async function assetClaim(id:number,state="claimed") {
  await pool.query(`INSERT INTO standard_asset_action_claims
    (execution_id,payer,provider_agent_id,service_id,operation,wallet_authorization_hash,request_hash,
     provider_control_profile_hash,servicing_admission_hash,action_catalog_hash,action_catalog_schema_hash,
     action_catalog_epoch,action_definition_hash,state)
    VALUES($1,$2,'7',$3,'use',$1,$1,$1,$1,$1,$1,1,$4,$5)`,
    [Buffer.alloc(32,id),"0x"+"22".repeat(20),Buffer.alloc(32,4),Buffer.alloc(32,12),state]);
}
it("requires a later action epoch and no failed/staged work, and fences claims and reintroducing epochs",async()=>{
  const oldActions=[{serviceId,actionDefinitionHash:h(12)}];
  const old=await catalog(1,oldActions);await admission(1,old);
  let view=await api.state(assetScope);
  expect(view).toMatchObject({retired:false,blockers:{activeAdmissions:1,retiringEpochRequired:1}});
  const next=await catalog(2,[]);await admission(2,next);
  await assetClaim(41,"failed");
  view=await api.state(assetScope);
  expect(view).toMatchObject({retired:false,blockers:{openClaims:1}});
  await expect(api.retire({...assetScope,requestId:"blocked-asset"})).rejects.toBeInstanceOf(RetirementBlocked);
  await pool.query("UPDATE standard_asset_action_claims SET state='completed'");
  const retired=await api.retire({...assetScope,requestId:"retire-asset"});
  expect(retired.receipt.payload.scope).toEqual(assetScope);
  await expect(assetClaim(42)).rejects.toThrow("CONTRACT_RETIRED");
  const revived=await catalog(3,oldActions);
  await expect(admission(3,revived)).rejects.toThrow("CONTRACT_RETIRED");
  const retained=await api.retainedAdmissions();
  expect(retained).toHaveLength(2);
  expect(retained[0]).toMatchObject({catalogKnown:true,actions:[{serviceId,actionDefinitionHash:h(12)}]});
},60_000);

it("rejects stale asset epoch activation even when the old snapshot cannot see retirement",async()=>{
  const oldActions=[{serviceId,actionDefinitionHash:h(12)}];
  const old=await catalog(1,oldActions);await admission(1,old);
  const next=await catalog(2,[]);await admission(2,next);
  const legacy=await pool.connect();
  try {
    await legacy.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await legacy.query("SELECT * FROM standard_provider_servicing_admissions");
    await api.retire({...assetScope,requestId:"retire-stale-epoch"});
    await expect(legacy.query("UPDATE standard_provider_servicing_admissions SET current=true WHERE current"))
      .rejects.toMatchObject({code:"40001"});
  } finally {await legacy.query("ROLLBACK");legacy.release();}
},60_000);

it("preserves buyer review and reputation rights after fulfilled listing retirement",async()=>{
  await order("completed","FULFILLED");
  await pool.query("UPDATE standard_orders SET deposit_evidence_hash=$1,release_evidence_hash=$1 WHERE order_id='completed'",[Buffer.alloc(32,9)]);
  await pool.query("INSERT INTO standard_rail_receipts(order_id,receipt_hash,canonical_receipt) VALUES('completed',$1,'{}')",[Buffer.alloc(32,9)]);
  await api.retire({...scope,requestId:"retire-fulfilled"});
  for (const version of ["","_v2"]) {
    const extra=version?",profile_id,signed_deadline,profile_observation,authorization_group":"";
    const extraValues=version?",'eas-native-1.0.1',NULL,'{}',gen_random_uuid()":"";
    await expect(pool.query(`INSERT INTO standard_confirmation_preparations`+version+`
      (order_id,order_key,payer,operation,submissions_used,eas_nonce,deadline,request_hash,canonical_typed_data,
       final_transition_acknowledged,expires_at`+extra+`)
      VALUES('completed',$1,'0x2222222222222222222222222222222222222222','attest-confirmation',0,0,1,$2,'{}',
       false,now()+interval '1 day'`+extraValues+`)`,[Buffer.alloc(32,1),Buffer.alloc(32,version?14:13)])).resolves.toBeDefined();
  }
  await expect(pool.query(`INSERT INTO standard_reputation_operations(order_id,kind,logical_key,intent_hash,canonical_intent,state)
    VALUES('completed','confirmation-v2',$1,$1,'{}','pending')`,[Buffer.alloc(32,18)])).resolves.toBeDefined();
  await expect(pool.query("UPDATE standard_orders SET capability_epoch=capability_epoch+1 WHERE order_id='completed'")).resolves.toBeDefined();
  await expect(order("new-after-review","DRAFT",listingManifestHash,2)).rejects.toThrow("CONTRACT_RETIRED");
},60_000);
