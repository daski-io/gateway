import { createHash } from "node:crypto";
import { recoverTypedDataAddress, serializeSignature, TransactionReceiptNotFoundError, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Pool } from "../db/pool.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardConfirmationState } from "./confirmationState.js";
import { EAS_IDENTITY_ABI, easProfile, observeEasProfile, signedDeadlineExpired, type EasProfileId } from "./easProfiles.js";
import { PostgresFacilitatorNonceLock, type FacilitatorNonceLock } from "./facilitatorNonceLock.js";
import { canonicalHash } from "./canonical.js";

export class ReviewRecoveryConflict extends Error {}
interface ReviewRow {
  operation_id: string; order_id: string; state: string; payer: `0x${string}`;
  profile_id: EasProfileId; signed_deadline: string | null; eas_nonce: string;
  authorization_group: string; canonical_typed_data: Record<string, any>;
  canonical_intent: Record<string, any>; protocol_v2: boolean;
}
export interface ReviewEvidence {
  blockNumber: string; blockHash: Hex; timestamp: string; nonce: string;
  deployedProfileId: EasProfileId; groupHash: string; hasFinalSuccess: boolean;
  transactions: Array<{ hash: Hex; disposition: string; blockNumber?: string; blockHash?: Hex }>;
}
type Disposition = "safe-to-retire" | "nonce-consumed" | "authorization-live" | "unresolved" | "already-retired";
export interface ReviewPreview {
  operationId: string; disposition: Disposition; reason: string;
  proofHash: string | null; evidence: ReviewEvidence | null;
}
const reviewsSql = `SELECT o.operation_id,o.order_id,o.state,o.canonical_intent,p.payer,p.profile_id,
 p.signed_deadline,p.eas_nonce,p.authorization_group,p.canonical_typed_data,p.protocol_v2
 FROM standard_reputation_operations o JOIN standard_review_sponsorships s USING(operation_id)
 JOIN standard_review_preparations p USING(preparation_id)`;

/** Local holds are released only by canonical finality evidence; transaction journals never disappear. */
export class StandardReviewRecovery {
  private readonly lock: FacilitatorNonceLock;
  constructor(
    private readonly pool: Pool, private readonly config: StandardRailConfig, private readonly chainId: number,
    private readonly chain: Pick<StandardConfirmationState, "observeWith">,
    lock?: FacilitatorNonceLock,
    private readonly reconcile: (operationId: string) => Promise<void> = async () => undefined,
  ) {
    this.lock = lock ?? new PostgresFacilitatorNonceLock(pool,chainId,privateKeyToAccount(config.reputationRelayerPrivateKey).address);
  }
  async inventory(limit = 100, cursor?: string) {
    const rows = await this.pool.query<ReviewRow>(`${reviewsSql}
      WHERE o.state IN ('pending','broadcast','operator_attention','authorization_live','superseded','confirmation_failed')
      AND ($2::uuid IS NULL OR o.operation_id>$2) ORDER BY o.operation_id LIMIT $1`, [Math.min(Math.max(limit,1),100),cursor ?? null]);
    return { items: rows.rows.map(r => ({ operationId:r.operation_id,orderId:r.order_id,state:r.state,
      profileId:r.profile_id,disposition:r.state === "confirmation_failed" ? "already-retired" : "unresolved",
      reason:"preview-required" })), ...(rows.rows.length === limit ? { nextCursor: rows.rows.at(-1)!.operation_id } : {}) };
  }
  private async rows(operationId: string, db: Pick<Pool,"query"> = this.pool) {
    const found = await db.query<ReviewRow>(`${reviewsSql} WHERE o.operation_id=$1`,[operationId]);
    const target = found.rows[0];
    if (!target) throw new ReviewRecoveryConflict("review_operation_not_found");
    const unadmitted = await db.query("SELECT 1 FROM standard_confirmation_preparations_v2 p WHERE authorization_group=$1 AND NOT EXISTS (SELECT 1 FROM standard_confirmation_sponsorships_v2 s WHERE s.preparation_id=p.preparation_id)",[target.authorization_group]);
    if (unadmitted.rowCount) throw new ReviewRecoveryConflict("unadmitted-alternative-requires-resolution");
    const group = await db.query<ReviewRow>(`${reviewsSql} WHERE p.authorization_group=$1 ORDER BY o.operation_id`,[target.authorization_group]);
    return { target, group: group.rows };
  }
  private groupHash(group: ReviewRow[]) {
    return canonicalHash(group.map(r => ({ operationId:r.operation_id,state:r.state,
      profile:r.profile_id,nonce:r.eas_nonce,deadline:r.signed_deadline,intent:r.canonical_intent,typedData:r.canonical_typed_data })));
  }
  private async knownAuthorization(row: ReviewRow): Promise<boolean> {
    const p = easProfile(row.profile_id);
    const typed = row.canonical_typed_data;
    const action = row.canonical_intent.operation;
    const primaryType = action === "attest-confirmation" ? "Attest" : action === "revoke-confirmation" ? "Revoke" : null;
    const expectedTypes = primaryType === "Attest" ? p.attestTypes : p.revokeTypes;
    const request = row.canonical_intent.request;
    const expectedMessage = primaryType === "Attest" ? {schema:request?.schema,...request?.data,nonce:row.eas_nonce} :
      {schema:request?.schema,uid:request?.data?.uid,value:request?.data?.value,nonce:row.eas_nonce};
    if (p.signedDeadline) expectedMessage.deadline = request?.deadline;
    else delete expectedMessage.value;
    let recovered: string;
    try {
      const signature = serializeSignature({...request.signature,v:BigInt(request.signature.v)});
      recovered = await recoverTypedDataAddress({...typed,signature} as never);
    } catch { return false; }
    return recovered.toLowerCase() === row.payer.toLowerCase() &&
      canonicalHash(expectedMessage) === canonicalHash(typed.message) && primaryType !== null && typed.primaryType === primaryType &&
      canonicalHash(typed.types) === canonicalHash(expectedTypes) &&
      typed.domain?.name === "EAS" && typed.domain.version === p.domainVersion &&
      Number(typed.domain.chainId) === this.chainId &&
      String(typed.domain.verifyingContract).toLowerCase() === this.config.easAddress.toLowerCase() &&
      String(typed.message?.nonce) === row.eas_nonce &&
      (p.signedDeadline ? String(typed.message?.deadline) === row.signed_deadline : typed.message?.deadline === undefined);
  }
  private async evidence(group: ReviewRow[], anchor?: { blockNumber: string; blockHash: Hex }): Promise<ReviewEvidence> {
    const journal = await this.pool.query<{ transaction_hash: Hex }>(
      "SELECT transaction_hash FROM standard_reputation_transactions WHERE operation_id=ANY($1::uuid[]) ORDER BY transaction_hash",
      [group.map(r => r.operation_id)]);
    return this.chain.observeWith(async ({client: raw}) => {
      const client = raw as unknown as PublicClient;
      const observation = await observeEasProfile(client,this.chainId,this.config.easAddress,this.config.finalityTag);
      const block = anchor ? await client.getBlock({blockNumber:BigInt(anchor.blockNumber)}) :
        await client.getBlock({blockNumber:BigInt(observation.blockNumber)});
      if (anchor && (block.hash !== anchor.blockHash || block.number > BigInt(observation.blockNumber)))
        throw new ReviewRecoveryConflict("preview_anchor_not_canonical");
      const nonce = await client.readContract({address:this.config.easAddress,abi:EAS_IDENTITY_ABI,
        functionName:"getNonce",args:[group[0]!.payer],blockNumber:block.number});
      const transactions: ReviewEvidence["transactions"] = [];
      for (const tx of journal.rows) {
        try {
          const receipt = await client.getTransactionReceipt({hash:tx.transaction_hash});
          if (receipt.blockNumber > block.number) { transactions.push({hash:tx.transaction_hash,disposition:"unfinalized"}); continue; }
          const canonical = await client.getBlock({blockNumber:receipt.blockNumber});
          if (canonical.hash !== receipt.blockHash) throw new ReviewRecoveryConflict("receipt_anchor_not_canonical");
          transactions.push({hash:tx.transaction_hash,disposition:receipt.status,
            blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash});
        } catch (error) {
          if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
          transactions.push({hash:tx.transaction_hash,disposition:"unknown"});
        }
      }
      if ((await client.getBlock({blockNumber:block.number})).hash !== block.hash) throw new ReviewRecoveryConflict("anchor_changed");
      return { blockNumber:block.number.toString(),blockHash:block.hash,timestamp:block.timestamp.toString(),
        nonce:nonce.toString(),deployedProfileId:observation.profileId,groupHash:this.groupHash(group),
        hasFinalSuccess:group.some(r=>r.state==="final") || transactions.some(t=>t.disposition==="success"),transactions };
    });
  }
  private async classify(group: ReviewRow[], evidence: ReviewEvidence): Promise<Pick<ReviewPreview,"disposition"|"reason">> {
    if ((await Promise.all(group.map(row => this.knownAuthorization(row)))).some(known => !known)) return {disposition:"unresolved",reason:"unrecognized-stored-authorization"};
    if (evidence.hasFinalSuccess && !group.some(row=>row.state === "final")) return {disposition:"unresolved",reason:"successful-receipt-requires-reconciliation"};
    if (group.every(row => BigInt(evidence.nonce) > BigInt(row.eas_nonce))) return {disposition:"nonce-consumed",reason:"finalized-payer-nonce-advanced"};
    if (group.every(row => signedDeadlineExpired(row.profile_id,row.signed_deadline,BigInt(evidence.timestamp))))
      return {disposition:"safe-to-retire",reason:"all-signed-deadlines-expired"};
    return {disposition:"authorization-live",reason:"signature-can-still-execute"};
  }
  async preview(operationIds: string[]): Promise<{items:ReviewPreview[]}> {
    const items: ReviewPreview[] = [];
    for (const operationId of operationIds) {
      try {
        await this.reconcile(operationId);
        const audit = await this.pool.query("SELECT 1 FROM standard_review_recovery WHERE operation_id=$1",[operationId]);
        if (audit.rowCount) { items.push({operationId,disposition:"already-retired",reason:"recovery-recorded",proofHash:null,evidence:null}); continue; }
        const {target,group} = await this.rows(operationId);
        if (target.state === "final") { items.push({operationId,disposition:"unresolved",reason:"already-successful",proofHash:null,evidence:null}); continue; }
        const evidence = await this.evidence(group);
        const classification = await this.classify(group,evidence);
        const proofHash = canonicalHash({operationId,...classification,evidence});
        await this.pool.query(`INSERT INTO standard_review_recovery_previews(proof_hash,operation_id,evidence)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[proofHash,operationId,evidence]);
        items.push({operationId,...classification,proofHash,evidence});
      } catch {
        items.push({operationId,disposition:"unresolved",reason:"evidence-unavailable-or-changed",proofHash:null,evidence:null});
      }
    }
    return {items};
  }
  async apply(input: {operationId:string;proofHash:string;idempotencyKey:string;releaseId:string}) {
    await this.reconcile(input.operationId);
    return this.lock.run(async () => {
      const prior = await this.pool.query<{result:Record<string,unknown>}>(
        "SELECT result FROM standard_review_recovery WHERE operation_id=$1",[input.operationId]);
      if (prior.rows[0]) return {...prior.rows[0].result,disposition:"already-retired"};
      const proof = await this.pool.query<{evidence:ReviewEvidence}>(
        "SELECT evidence FROM standard_review_recovery_previews WHERE operation_id=$1 AND proof_hash=$2",
        [input.operationId,input.proofHash]);
      if (!proof.rows[0]) throw new ReviewRecoveryConflict("preview_required");
      const {target,group} = await this.rows(input.operationId);
      if (target.state === "final") throw new ReviewRecoveryConflict("already_successful");
      const evidence = await this.evidence(group,proof.rows[0].evidence);
      const classification = await this.classify(group,evidence);
      const hash = canonicalHash({operationId:input.operationId,...classification,evidence});
      if (hash !== input.proofHash) throw new ReviewRecoveryConflict("preview_changed");
      if (!["safe-to-retire","nonce-consumed"].includes(classification.disposition)) throw new ReviewRecoveryConflict(classification.reason);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('confirmation-prepare:' || $1::text,0))",[target.payer.toLowerCase()]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["confirmation-sponsorship"]);
        const locked = await client.query(`SELECT operation_id FROM standard_reputation_operations
          WHERE operation_id=ANY($1::uuid[]) FOR UPDATE`,[group.map(r=>r.operation_id)]);
        if (locked.rowCount !== group.length || this.groupHash((await this.rows(input.operationId,client)).group) !== evidence.groupHash)
          throw new ReviewRecoveryConflict("preview_changed");
        const allowanceReleased = classification.disposition === "safe-to-retire";
        const result = {operationId:input.operationId,disposition:"retired",safeRetired:true,allowanceReleased,evidence,
          relayerCleanupOutstanding:evidence.transactions.filter(tx=>["unknown","unfinalized"].includes(tx.disposition))};
        const ids = group.filter(r=>r.state!=="final").map(r=>r.operation_id);
        await client.query(`UPDATE standard_reputation_operations SET state='confirmation_failed',next_attempt_at=NULL,
          result=$2,last_error_class='review_safely_retired',updated_at=now() WHERE operation_id=ANY($1::uuid[])`,[ids,result]);
        // An advanced nonce without the matching receipt cannot prove who consumed allowance.
        if (allowanceReleased) for (const table of ["standard_confirmation_sponsorships","standard_confirmation_sponsorships_v2"])
          await client.query(`UPDATE ${table} SET state='released',updated_at=now()
            WHERE operation_id=ANY($1::uuid[]) AND state='reserved'`,[ids]);
        for (const id of ids) {
          const key = id === input.operationId ? input.idempotencyKey : createHash("sha256").update(input.idempotencyKey+":"+id).digest("hex");
          await client.query(`INSERT INTO standard_review_recovery(operation_id,idempotency_key,release_id,proof_hash,result)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(operation_id) DO NOTHING`,[id,key,input.releaseId,input.proofHash,{...result,operationId:id}]);
        }
        await client.query(`INSERT INTO standard_operator_actions(actor,action,target_id,details)
          VALUES('catalog-operator','review_recovery',$1,$2)`,[input.operationId,{releaseId:input.releaseId,proofHash:input.proofHash,group:ids,result}]);
        await client.query("COMMIT");
        return result;
      } catch(error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; }
      finally {client.release();}
    });
  }
}
