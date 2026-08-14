import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  encodeAbiParameters,
  fallback,
  getAddress,
  http,
  parseAbi,
  parseAbiParameters,
  parseSignature,
  verifyTypedData,
  type Chain,
  type Hex,
} from "viem";
import type { Pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import type { ConfirmationIntent, RevokeConfirmationIntent } from "./reputationOperation.js";
import type { StandardOrderRecord } from "./types.js";

const ZERO = `0x${"00".repeat(32)}` as Hex;
const confirmationPayload = parseAbiParameters("bytes32 orderKey,uint8 confirmation");
const reads = parseAbi([
  "function getNonce(address account) view returns (uint256)",
  "function getRecord(bytes32 orderKey) view returns ((bytes32 orderKey,bytes32 authorizationKey,uint256 providerAgentId,bytes32 serviceId,address payer,address providerOwner,address providerAgentWallet,address providerPayee,address canonicalToken,uint256 grossAmount,uint64 paidAt,bytes32 providerIdentitySnapshotHash,bytes32 listingManifestHash,bytes32 releaseEvidenceHash,uint8 outcome,uint8 confirmation,uint64 outcomeAttestationDelay,uint64 outcomeTimestamp,uint64 confirmationTimestamp,uint8 confirmationTransitions,bool outcomeRecorded,bool reputationEligible,bytes32 currentConfirmationUid))",
]);

const attestTypes = { Attest: [
  { name: "schema", type: "bytes32" }, { name: "recipient", type: "address" },
  { name: "expirationTime", type: "uint64" }, { name: "revocable", type: "bool" },
  { name: "refUID", type: "bytes32" }, { name: "data", type: "bytes" },
  { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint64" },
] } as const;
const revokeTypes = { Revoke: [
  { name: "schema", type: "bytes32" }, { name: "uid", type: "bytes32" },
  { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint64" },
] } as const;

interface PreparationRow {
  preparation_id: string;
  order_id: string;
  operation: "attest-confirmation" | "revoke-confirmation";
  confirmation: "Confirmed" | "NotConfirmed" | null;
  current_uid: Buffer | null;
  transitions_used: number;
  eas_nonce: string;
  deadline: string;
  canonical_typed_data: { domain: Record<string, unknown>; types: typeof attestTypes | typeof revokeTypes;
    primaryType: "Attest" | "Revoke"; message: Record<string, unknown> };
  final_transition_acknowledged: boolean;
  consumed_at: Date | null;
  expires_at: Date;
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new Error("CONFIRMATION_REQUEST_INVALID");
  }
}

export class StandardConfirmations {
  private readonly client;

  constructor(private readonly pool: Pool, private readonly config: StandardRailConfig, chain: Chain) {
    this.client = createPublicClient({
      chain,
      transport: fallback(config.evidenceRpcUrls.map((url) =>
        http(url, { retryCount: 0, timeout: 20_000 })), { rank: false }),
    });
  }

  async assertReady(order: StandardOrderRecord): Promise<void> {
    const result = await this.pool.query<{ state: string }>(
      `SELECT state FROM standard_reputation_operations
        WHERE order_id=$1 AND kind='register'`,
      [order.orderId],
    );
    const state = result.rows[0]?.state;
    if (state === "final") return;
    if (state === "aborted_unattested" || state === "blocked_parent_aborted") {
      throw new Error("REPUTATION_UNAVAILABLE");
    }
    throw new Error("REPUTATION_NOT_READY");
  }

  async handle(order: StandardOrderRecord, action: "confirmation" | "revoke-confirmation",
    request: Record<string, unknown>) {
    if (request.phase === "prepare") return this.prepare(order, action, request);
    if (request.phase === "submit") return this.submit(order, action, request);
    throw new Error("CONFIRMATION_REQUEST_INVALID");
  }

  private async current(order: StandardOrderRecord) {
    let record;
    try {
      record = await this.client.readContract({ address: this.config.reputationContract,
        abi: reads, functionName: "getRecord", args: [order.orderKey] });
    } catch {
      throw new Error("CONFIRMATION_SPONSORSHIP_UNAVAILABLE");
    }
    if (record.orderKey === ZERO || getAddress(record.payer) !== getAddress(order.payer!)) {
      throw new Error("CONFIRMATION_ORDER_UNAVAILABLE");
    }
    return record;
  }

  private async prepare(order: StandardOrderRecord, action: "confirmation" | "revoke-confirmation",
    request: Record<string, unknown>) {
    exact(request, action === "confirmation"
      ? ["phase", "confirmation", "acknowledgeFinalTransition"]
      : ["phase", "acknowledgeFinalTransition"]);
    if (action === "confirmation" && request.confirmation !== "Confirmed" &&
      request.confirmation !== "NotConfirmed") throw new Error("CONFIRMATION_REQUEST_INVALID");
    if (typeof request.acknowledgeFinalTransition !== "boolean") {
      throw new Error("CONFIRMATION_REQUEST_INVALID");
    }
    const current = await this.current(order);
    if (action === "revoke-confirmation" && current.currentConfirmationUid === ZERO) {
      throw new Error("CONFIRMATION_NOT_ACTIVE");
    }
    const used = Number(current.confirmationTransitions);
    if (used >= 3) throw new Error("CONFIRMATION_TRANSITION_LIMIT");
    const final = used === 2;
    const warning = { transitionsUsed: used, transitionsRemainingBefore: 3 - used,
      usesFinalPermittedTransition: final };
    if (final && request.acknowledgeFinalTransition !== true) return {
      ...warning,
      warning: { code: "FINAL_CONFIRMATION_TRANSITION",
        message: "This is the final permitted confirmation change; it cannot later be revised or withdrawn." },
      signableTypedData: null,
    };
    const payer = getAddress(order.payer!);
    let nonce;
    try {
      nonce = await this.client.readContract({ address: this.config.easAddress, abi: reads,
        functionName: "getNonce", args: [payer] });
    } catch {
      throw new Error("CONFIRMATION_SPONSORSHIP_UNAVAILABLE");
    }
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + this.config.confirmationDeadlineSeconds);
    const recipient = current.providerAgentWallet === "0x0000000000000000000000000000000000000000"
      ? current.providerOwner : current.providerAgentWallet;
    const domain = { name: "EAS", version: "1.2.0", chainId: this.client.chain!.id,
      verifyingContract: this.config.easAddress };
    const typedData = action === "confirmation" ? {
      domain, types: attestTypes, primaryType: "Attest" as const,
      message: { schema: this.config.reputationConfirmationSchemaUid, recipient,
        expirationTime: "0", revocable: true, refUID: current.currentConfirmationUid,
        data: encodeAbiParameters(confirmationPayload, [order.orderKey,
          request.confirmation === "Confirmed" ? 1 : 2]), value: "0", nonce: nonce.toString(),
        deadline: deadline.toString() },
    } : {
      domain, types: revokeTypes, primaryType: "Revoke" as const,
      message: { schema: this.config.reputationConfirmationSchemaUid,
        uid: current.currentConfirmationUid, value: "0", nonce: nonce.toString(),
        deadline: deadline.toString() },
    };
    const preparationId = randomUUID();
    const requestHash = canonicalHash({ orderKey: order.orderKey, operation: action,
      currentUid: current.currentConfirmationUid, transitionsUsed: used, nonce: nonce.toString(),
      deadline: deadline.toString(), typedData });
    await this.pool.query(
      `INSERT INTO standard_confirmation_preparations
        (preparation_id,order_id,order_key,payer,operation,confirmation,current_uid,transitions_used,
         eas_nonce,deadline,request_hash,canonical_typed_data,final_transition_acknowledged,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_timestamp($10))`,
      [preparationId, order.orderId, Buffer.from(order.orderKey.slice(2), "hex"), payer.toLowerCase(),
        action === "confirmation" ? "attest-confirmation" : "revoke-confirmation",
        action === "confirmation" ? request.confirmation : null,
        current.currentConfirmationUid === ZERO ? null : Buffer.from(current.currentConfirmationUid.slice(2), "hex"),
        used, nonce.toString(), deadline.toString(), Buffer.from(requestHash.slice(2), "hex"), typedData, final],
    );
    return { ...warning, preparationId, orderKey: order.orderKey,
      currentRefUid: current.currentConfirmationUid, signableTypedData: typedData };
  }

  private async submit(order: StandardOrderRecord, action: "confirmation" | "revoke-confirmation",
    request: Record<string, unknown>) {
    exact(request, ["phase", "preparationId", "signature"]);
    if (typeof request.preparationId !== "string" || typeof request.signature !== "string" ||
      !/^0x[0-9a-fA-F]{130}$/.test(request.signature)) throw new Error("CONFIRMATION_REQUEST_INVALID");
    const result = await this.pool.query<PreparationRow>(
      "SELECT * FROM standard_confirmation_preparations WHERE preparation_id=$1 AND order_id=$2",
      [request.preparationId, order.orderId],
    );
    const prep = result.rows[0];
    if (!prep || prep.operation !== (action === "confirmation" ? "attest-confirmation" : "revoke-confirmation") ||
      prep.expires_at.getTime() <= Date.now()) throw new Error("CONFIRMATION_PREPARATION_STALE");
    if (prep.consumed_at) {
      const existing = await this.pool.query<{ operation_id: string; state: string }>(
        `SELECT o.operation_id,o.state FROM standard_confirmation_sponsorships s
          JOIN standard_reputation_operations o ON o.operation_id=s.operation_id
         WHERE s.preparation_id=$1`, [prep.preparation_id]);
      if (existing.rows[0]) return { operationId: existing.rows[0].operation_id,
        state: existing.rows[0].state };
      throw new Error("CONFIRMATION_PREPARATION_STALE");
    }
    const valid = await verifyTypedData({ address: getAddress(order.payer!),
      ...prep.canonical_typed_data, signature: request.signature as Hex } as never);
    if (!valid) throw new Error("CONFIRMATION_SIGNATURE_INVALID");
    const current = await this.current(order);
    const expectedUid = prep.current_uid ? `0x${prep.current_uid.toString("hex")}` : ZERO;
    let nonce;
    try {
      nonce = await this.client.readContract({ address: this.config.easAddress, abi: reads,
        functionName: "getNonce", args: [getAddress(order.payer!)] });
    } catch {
      throw new Error("CONFIRMATION_SPONSORSHIP_UNAVAILABLE");
    }
    if (Number(current.confirmationTransitions) !== prep.transitions_used ||
      current.currentConfirmationUid.toLowerCase() !== expectedUid.toLowerCase() || nonce.toString() !== prep.eas_nonce) {
      throw new Error("CONFIRMATION_PREPARATION_STALE");
    }
    return this.reserve(order, prep, request.signature as Hex);
  }

  private async reserve(order: StandardOrderRecord, prep: PreparationRow, signature: Hex) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["confirmation-sponsorship"]);
      const counts = await client.query<{ order_count: string; payer_count: string; global_count: string }>(
        `SELECT count(*) FILTER (WHERE order_id=$1 AND state<>'released')::text AS order_count,
                count(*) FILTER (WHERE payer=$2 AND utc_day=(now() AT TIME ZONE 'UTC')::date
                  AND state<>'released')::text AS payer_count,
                count(*) FILTER (WHERE utc_day=(now() AT TIME ZONE 'UTC')::date
                  AND state<>'released')::text AS global_count
           FROM standard_confirmation_sponsorships`, [order.orderId, order.payer!.toLowerCase()]);
      const count = counts.rows[0]!;
      if (Number(count.order_count) >= this.config.confirmationMaxPerOrder ||
        Number(count.payer_count) >= this.config.confirmationMaxPerPayerPerDay ||
        Number(count.global_count) >= this.config.confirmationMaxGlobalPerDay) {
        throw new Error("CONFIRMATION_SPONSORSHIP_LIMIT");
      }
      const parts = parseSignature(signature);
      const message = prep.canonical_typed_data.message;
      const intent: ConfirmationIntent | RevokeConfirmationIntent = prep.operation === "attest-confirmation" ? {
        operation: "attest-confirmation", orderKey: order.orderKey, orderId: order.orderId,
        outcomeId: order.outcomeId, confirmation: prep.confirmation!, transitionsUsed: prep.transitions_used,
        request: { schema: message.schema as Hex,
          data: { recipient: getAddress(String(message.recipient)), expirationTime: "0", revocable: true,
            refUID: message.refUID as Hex, data: message.data as Hex, value: "0" },
          signature: { v: Number(parts.v), r: parts.r, s: parts.s },
          attester: getAddress(order.payer!), deadline: prep.deadline },
      } : {
        operation: "revoke-confirmation", orderKey: order.orderKey, orderId: order.orderId,
        outcomeId: order.outcomeId, transitionsUsed: prep.transitions_used,
        request: { schema: message.schema as Hex, data: { uid: message.uid as Hex, value: "0" },
          signature: { v: Number(parts.v), r: parts.r, s: parts.s },
          revoker: getAddress(order.payer!), deadline: prep.deadline },
      };
      const operationId = randomUUID();
      const logicalKey = canonicalHash({ preparationId: prep.preparation_id, operation: prep.operation });
      const intentHash = canonicalHash(intent);
      await client.query(
        `INSERT INTO standard_reputation_operations
          (operation_id,order_id,kind,logical_key,intent_hash,canonical_intent,state,next_attempt_at)
         VALUES ($1,$2,'confirmation',$3,$4,$5,'pending',now())`,
        [operationId, order.orderId, Buffer.from(logicalKey.slice(2), "hex"),
          Buffer.from(intentHash.slice(2), "hex"), intent],
      );
      await client.query(
        `INSERT INTO standard_confirmation_sponsorships
          (preparation_id,operation_id,order_id,payer,utc_day,state)
         VALUES ($1,$2,$3,$4,(now() AT TIME ZONE 'UTC')::date,'reserved')`,
        [prep.preparation_id, operationId, order.orderId, order.payer!.toLowerCase()],
      );
      await client.query("UPDATE standard_confirmation_preparations SET consumed_at=now() WHERE preparation_id=$1",
        [prep.preparation_id]);
      await client.query("COMMIT");
      return { operationId, state: "pending" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
