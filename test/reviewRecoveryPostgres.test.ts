import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionReceiptNotFoundError, parseSignature, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import type { StandardConfirmationState } from "../src/standardRail/confirmationState.js";
import { easProfile, observeEasProfile, type EasProfileId } from "../src/standardRail/easProfiles.js";
import { StandardReviewRecovery } from "../src/standardRail/reviewRecovery.js";

vi.mock("../src/standardRail/easProfiles.js", async (load) => ({
  ...await load<typeof import("../src/standardRail/easProfiles.js")>(),
  observeEasProfile: vi.fn(),
}));

const databaseUrl = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const schema = "review_recovery_" + randomUUID().replaceAll("-", "");
const hex = (c: string): Hex => `0x${c.repeat(64)}`;
const signer = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const payer = signer.address.toLowerCase() as Hex;
const easAddress = `0x${"e".repeat(40)}` as const;
const orderId = "ord_11111111-1111-4111-8111-111111111111";
const config = { reputationRelayerPrivateKey: `0x${"33".repeat(32)}`, easAddress, finalityTag: "finalized" } as StandardRailConfig;
let bootstrap: Pool, pool: Pool;
let subject: StandardReviewRecovery;
let nonce: bigint, timestamp: bigint, blockHash: Hex;
const receipts = new Map<string, { status: "success" | "reverted"; blockNumber: bigint; blockHash: Hex }>();
const client = {
  getBlock: async ({ blockNumber = 100n }: { blockNumber?: bigint }) => ({ number: blockNumber, hash: blockNumber === 100n ? blockHash : hex("9"), timestamp }),
  readContract: async () => nonce,
  getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
    const receipt = receipts.get(hash);
    if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
    return receipt;
  },
};
const chain = { observeWith: async (work: (arg: unknown) => Promise<unknown>) => work({ client }) } as unknown as Pick<StandardConfirmationState, "observeWith">;

beforeAll(async () => {
  bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 8 });
  await runMigrations(pool);
  await pool.query(`INSERT INTO standard_orders(
    order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
    listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,canonical_request_hash,
    canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,expires_at,payer)
    VALUES($1,$2,'review-test-handle',$3,'FULFILLED','42','register-domain','recipe-bound-v2',
    $4,$5,'{}',$6,'{}',$7,'{}',$8,'int_11111111-1111-4111-8111-111111111111',5000000,1,1,now()+interval '1 day',$9)`,
    [orderId,randomBytes(32),randomBytes(32),randomBytes(32),randomBytes(32),randomBytes(32),randomBytes(32),randomBytes(32),payer]);
}, 120_000);
beforeEach(async () => {
  await pool.query("TRUNCATE standard_confirmation_preparations,standard_confirmation_preparations_v2,standard_reputation_operations CASCADE");
  await pool.query("DELETE FROM standard_operator_actions");
  nonce = 7n; timestamp = 500n; blockHash = hex("1"); receipts.clear();
  vi.mocked(observeEasProfile).mockImplementation(async () => ({
    profileId: "eas-native-1.0.1", contractVersion: "1.0.1", domainVersion: "1.0.1",
    implementation: easAddress, implementationCodeHash: hex("2"), domainSeparator: hex("3"),
    chainId: 8453, easAddress, blockNumber: "100", blockHash, timestamp: timestamp.toString(),
  }));
  subject = new StandardReviewRecovery(pool, config, 8453, chain);
});
afterAll(async () => {
  await pool?.end();
  await bootstrap?.query(`DROP SCHEMA "${schema}" CASCADE`);
  await bootstrap?.end();
});
async function seed({ profileId = "eas-native-1.2.0", deadline = "100", group, legacy = false, admitted = true }:
  { profileId?: EasProfileId; deadline?: string; group?: string; legacy?: boolean; admitted?: boolean } = {}) {
  const preparationId = randomUUID(), operationId = randomUUID(), p = easProfile(profileId);
  const canonicalTypedData = {
    domain: { name: "EAS", version: p.domainVersion, chainId: 8453, verifyingContract: easAddress },
    types: p.attestTypes, primaryType: "Attest",
    message: { schema:hex("5"), recipient:payer, expirationTime:"0", revocable:true, refUID:hex("0"), data:"0x1234",
      nonce:"7", ...(p.signedDeadline ? {value:"0",deadline} : {}) },
  };
  const signature = parseSignature(await signer.signTypedData(canonicalTypedData as never));
  const request = { schema: hex("5"), data: {recipient:payer,expirationTime:"0",revocable:true,refUID:hex("0"),data:"0x1234",value:"0"},
    attester:payer, signature: {...signature,v:signature.v!.toString()}, ...(p.signedDeadline ? {deadline} : {}) };
  const table = legacy ? "standard_confirmation_preparations" : "standard_confirmation_preparations_v2";
  await pool.query(`INSERT INTO ${table}(preparation_id,order_id,order_key,payer,operation,confirmation,submissions_used,
    eas_nonce,deadline,request_hash,canonical_typed_data,final_transition_acknowledged,consumed_at,expires_at
    ${legacy ? "" : ",profile_id,signed_deadline,profile_observation,authorization_group"})
    VALUES($1,$2,$3,$4,'attest-confirmation','Confirmed',0,7,$5,$6,$7,false,now(),now()-interval '1 day'
    ${legacy ? "" : ",$8,$9,'{}',$10"})`,
    [preparationId,orderId,randomBytes(32),payer,deadline,randomBytes(32),canonicalTypedData,
      ...legacy ? [] : [profileId,p.signedDeadline ? deadline : null,group ?? preparationId]]);
  if (!admitted) return { operationId, preparationId, group: group ?? preparationId };
  await pool.query(`INSERT INTO standard_reputation_operations(operation_id,order_id,kind,logical_key,intent_hash,canonical_intent,state)
    VALUES($1,$2,$3,$4,$5,$6,'operator_attention')`,[operationId,orderId,legacy ? "confirmation" : "confirmation-v2",randomBytes(32),randomBytes(32),{operation:"attest-confirmation",request}]);
  await pool.query(`INSERT INTO ${legacy ? "standard_confirmation_sponsorships" : "standard_confirmation_sponsorships_v2"}
    (preparation_id,operation_id,order_id,payer,utc_day,state) VALUES($1,$2,$3,$4,current_date,'reserved')`,
    [preparationId,operationId,orderId,payer]);
  return { operationId, preparationId, group: group ?? preparationId };
}
async function journal(operationId: string, txHash: Hex, state = "failed") {
  await pool.query(`INSERT INTO standard_reputation_transactions(operation_id,chain_id,relayer_address,nonce,destination,
    value,intent_hash,calldata_hash,encrypted_raw_transaction,transaction_hash,state)
    VALUES($1,8453,$2,12,$3,0,$4,$5,$6,$7,$8)`,[operationId,payer,easAddress,randomBytes(32),randomBytes(32),Buffer.from([1,2,3]),txHash,state]);
}
async function proof(operationId: string) { return (await subject.preview([operationId])).items[0]!; }
const applyInput = (operationId: string, proofHash: string) => ({ operationId, proofHash, idempotencyKey: randomUUID(), releaseId: "2026-09-29-review-repair" });
async function states(operationId: string) {
  return (await pool.query(`SELECT o.state,s.state AS allowance FROM standard_reputation_operations o
    JOIN standard_review_sponsorships s USING(operation_id) WHERE operation_id=$1`,[operationId])).rows[0];
}

describe("review recovery proofs and PostgreSQL atomicity", () => {
  it("recovers pre-v2 expired wrong-profile signatures, releases allowance once and preserves unknown transaction bytes", async () => {
    const {operationId} = await seed({legacy:true});
    await journal(operationId,hex("a"),"operator_attention");
    const preview=await proof(operationId);
    expect(preview).toMatchObject({disposition:"safe-to-retire",evidence:{nonce:"7",transactions:[{disposition:"unknown"}]}});
    const input=applyInput(operationId,preview.proofHash!);
    expect(await subject.apply(input)).toMatchObject({safeRetired:true,allowanceReleased:true});
    expect(await states(operationId)).toEqual({state:"confirmation_failed",allowance:"released"});
    expect(await subject.apply(input)).toMatchObject({disposition:"already-retired",safeRetired:true});
    expect(await proof(operationId)).toMatchObject({disposition:"already-retired",proofHash:null});
    expect((await pool.query("SELECT * FROM standard_review_recovery")).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM standard_operator_actions WHERE action='review_recovery'")).rowCount).toBe(1);
    expect((await pool.query("SELECT encrypted_raw_transaction,state FROM standard_reputation_transactions")).rows[0])
      .toEqual({encrypted_raw_transaction:Buffer.from([1,2,3]),state:"operator_attention"});
  });
  it("never retires a valid nonexpiring legacy authorization due to local expiry or missing receipt",async()=>{
    const {operationId}=await seed({profileId:"eas-native-1.0.1"});
    await journal(operationId,hex("b"));
    const preview=await proof(operationId);
    expect(preview.disposition).toBe("authorization-live");
    await expect(subject.apply(applyInput(operationId,preview.proofHash!))).rejects.toThrow("signature-can-still-execute");
    expect(await states(operationId)).toEqual({state:"operator_attention",allowance:"reserved"});
  });
  it("retires on finalized nonce advancement without claiming success or restoring unproven allowance",async()=>{
    const {operationId}=await seed({profileId:"eas-native-1.0.1"});nonce=8n;
    const preview=await proof(operationId);expect(preview.disposition).toBe("nonce-consumed");
    expect(await subject.apply(applyInput(operationId,preview.proofHash!))).toMatchObject({safeRetired:true,allowanceReleased:false});
    expect(await states(operationId)).toEqual({state:"confirmation_failed",allowance:"reserved"});
  });
  it("requires reconciliation for a successful finalized receipt even when the deadline expired",async()=>{
    const {operationId}=await seed();await journal(operationId,hex("c"));
    receipts.set(hex("c"),{status:"success",blockNumber:90n,blockHash:hex("9")});
    const preview=await proof(operationId);
    expect(preview).toMatchObject({disposition:"unresolved",reason:"successful-receipt-requires-reconciliation"});
    await expect(subject.apply(applyInput(operationId,preview.proofHash!))).rejects.toThrow("successful-receipt-requires-reconciliation");
    expect((await pool.query("SELECT * FROM standard_review_recovery")).rowCount).toBe(0);
  });
  it("checks the entire same-nonce group and refuses an unadmitted alternative",async()=>{
    const first=await seed();await seed({profileId:"eas-native-1.0.1",group:first.group});
    expect((await proof(first.operationId)).disposition).toBe("authorization-live");
    await seed({group:first.group,admitted:false});
    expect(await proof(first.operationId)).toMatchObject({disposition:"unresolved",proofHash:null});
  });
  it("retires every expired sibling atomically, keeps all sponsor records and audits each operation",async()=>{
    const first=await seed(),second=await seed({group:first.group});
    const preview=await proof(first.operationId);await subject.apply(applyInput(first.operationId,preview.proofHash!));
    expect(await states(first.operationId)).toEqual({state:"confirmation_failed",allowance:"released"});
    expect(await states(second.operationId)).toEqual({state:"confirmation_failed",allowance:"released"});
    expect((await pool.query("SELECT * FROM standard_review_recovery")).rowCount).toBe(2);
    expect((await pool.query("SELECT * FROM standard_review_sponsorships")).rowCount).toBe(2);
  });
  it("rejects stale proofs after an authorization changes and after a canonical block changes",async()=>{
    const {operationId}=await seed(),preview=await proof(operationId);
    await pool.query("UPDATE standard_reputation_operations SET state='pending' WHERE operation_id=$1",[operationId]);
    await expect(subject.apply(applyInput(operationId,preview.proofHash!))).rejects.toThrow("preview_changed");
    const refreshed=await proof(operationId);blockHash=hex("4");
    await expect(subject.apply(applyInput(operationId,refreshed.proofHash!))).rejects.toThrow("preview_anchor_not_canonical");
    expect(await states(operationId)).toEqual({state:"pending",allowance:"reserved"});
  });
  it("serializes concurrent recovery requests so allowance and audit change once",async()=>{
    const {operationId}=await seed(),preview=await proof(operationId),input=applyInput(operationId,preview.proofHash!);
    const results=await Promise.all([subject.apply(input),subject.apply(input)]);
    expect(results.map(r=>r.disposition).sort()).toEqual(["already-retired","retired"]);
    expect((await pool.query("SELECT * FROM standard_review_recovery")).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM standard_operator_actions WHERE action='review_recovery'")).rowCount).toBe(1);
  });
  it("rolls back every bookkeeping change if the audit insert fails",async()=>{
    const {operationId}=await seed(),preview=await proof(operationId);
    await pool.query("ALTER TABLE standard_review_recovery ADD CONSTRAINT force_recovery_failure CHECK (release_id<>'2026-09-29-review-repair')");
    try {
      await expect(subject.apply(applyInput(operationId,preview.proofHash!))).rejects.toThrow("force_recovery_failure");
      expect(await states(operationId)).toEqual({state:"operator_attention",allowance:"reserved"});
      expect((await pool.query("SELECT * FROM standard_review_recovery")).rowCount).toBe(0);
      expect((await pool.query("SELECT * FROM standard_operator_actions WHERE action='review_recovery'")).rowCount).toBe(0);
    } finally {await pool.query("ALTER TABLE standard_review_recovery DROP CONSTRAINT force_recovery_failure");}
  });
  it("retires a losing sibling only after a bound group winner finalized, preserving the winning charge",async()=>{
    const winner=await seed(),loser=await seed({group:winner.group});
    await pool.query("UPDATE standard_reputation_operations SET state='final' WHERE operation_id=$1",[winner.operationId]);
    await pool.query("UPDATE standard_confirmation_sponsorships_v2 SET state='charged' WHERE operation_id=$1",[winner.operationId]);
    nonce=8n;
    const preview=await proof(loser.operationId);
    expect(preview.disposition).toBe("nonce-consumed");
    expect(await subject.apply(applyInput(loser.operationId,preview.proofHash!))).toMatchObject({safeRetired:true,allowanceReleased:false});
    expect(await states(winner.operationId)).toEqual({state:"final",allowance:"charged"});
    expect(await states(loser.operationId)).toEqual({state:"confirmation_failed",allowance:"reserved"});
    expect((await pool.query("SELECT operation_id FROM standard_review_recovery")).rows).toEqual([{operation_id:loser.operationId}]);
    expect((await proof(winner.operationId)).disposition).toBe("unresolved");
  });
  it("requires a real payer signature whose typed payload matches the persisted transaction request",async()=>{
    const first=await seed();
    await pool.query("UPDATE standard_reputation_operations SET canonical_intent=jsonb_set(canonical_intent,'{request,data,data}',to_jsonb($2::text)) WHERE operation_id=$1",[first.operationId,"0xffff"]);
    expect(await proof(first.operationId)).toMatchObject({disposition:"unresolved",reason:"unrecognized-stored-authorization"});
    const second=await seed();
    await pool.query("UPDATE standard_confirmation_preparations_v2 SET payer=$2 WHERE preparation_id=$1",[second.preparationId,"0x"+"b".repeat(40)]);
    expect(await proof(second.operationId)).toMatchObject({disposition:"unresolved",reason:"unrecognized-stored-authorization"});
  });
  it("refuses unknown typed-data shapes and treats equal signed deadline as still live",async()=>{
    const {operationId,preparationId}=await seed({deadline:"500"});
    expect((await proof(operationId)).disposition).toBe("authorization-live");
    await pool.query("UPDATE standard_confirmation_preparations_v2 SET canonical_typed_data=jsonb_set(canonical_typed_data,'{domain,version}','\"9.9.9\"') WHERE preparation_id=$1",[preparationId]);
    expect(await proof(operationId)).toMatchObject({disposition:"unresolved",reason:"unrecognized-stored-authorization"});
  });
});
