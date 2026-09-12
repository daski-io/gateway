import { randomUUID } from "node:crypto";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseAbiParameters,
  parseSignature,
  recoverTypedDataAddress,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import type { Pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import {
  reputationReadsAbi,
  ZERO_UID,
  type ConfirmationFinal,
  type ConfirmationObservation,
  type StandardConfirmationState,
} from "./confirmationState.js";
import { standardRailError } from "./errors.js";
import type { ConfirmationIntent, RevokeConfirmationIntent } from "./reputationOperation.js";
import type { StandardOrderRecord } from "./types.js";

/** On-chain cap on attestations per order (ReputationStorage `confirmationSubmissions < 3`). */
export const CONFIRMATION_ATTESTATION_CAP = 3;
/** Sponsored revocations per order; the chain itself caps none. */
export const SPONSORED_REVOCATIONS_PER_ORDER = 3;
export const CONFIRMATION_SUBMISSION_MODES = ["sponsored", "direct"] as const;
export type ConfirmationSubmissionMode = typeof CONFIRMATION_SUBMISSION_MODES[number];
/**
 * The closed request shape each phase accepts, per action: exactly these keys,
 * nothing else. Published as the `confirmation-request-shapes.json` wire
 * fixture so every consumer's offline tests build requests against the same
 * key sets this parser enforces.
 */
export const CONFIRMATION_REQUEST_SHAPES = {
  confirmation: {
    prepare: ["phase", "submission", "confirmation", "acknowledgeFinalTransition"],
    submit: ["phase", "submission", "preparationId", "signature"],
    check: ["phase", "submission"],
  },
  "revoke-confirmation": {
    prepare: ["phase", "submission"],
    submit: ["phase", "submission", "preparationId", "signature"],
    check: ["phase", "submission"],
  },
} as const;
export const FINAL_ATTESTATION_WARNING = {
  code: "FINAL_CONFIRMATION_SUBMISSION",
  message: "this is the last confirmation you can submit; it can still be revoked",
} as const;

const HALF_CURVE_ORDER = BigInt(
  "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0",
);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const confirmationPayload = parseAbiParameters("bytes32 orderKey,uint8 confirmation");
const easNonceAbi = parseAbi([
  "function getNonce(address account) view returns (uint256)",
]);
const easDirectAbi = parseAbi([
  "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)",
  "function revoke((bytes32 schema,(bytes32 uid,uint256 value) data) request) payable",
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
  submissions_used: number;
  eas_nonce: string;
  deadline: string;
  canonical_typed_data: { domain: Record<string, unknown>; types: typeof attestTypes | typeof revokeTypes;
    primaryType: "Attest" | "Revoke"; message: Record<string, unknown> };
  final_transition_acknowledged: boolean;
  consumed_at: Date | null;
  expires_at: Date;
}

export const CONFIRMATION_PREPARATION_INSERT_SQL = `INSERT INTO standard_confirmation_preparations
  (preparation_id,order_id,order_key,payer,operation,confirmation,current_uid,submissions_used,
   eas_nonce,deadline,request_hash,canonical_typed_data,final_transition_acknowledged,expires_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::bigint,$11,$12,$13,
   to_timestamp($10::double precision))`;

type Action = "confirmation" | "revoke-confirmation";

export interface ConfirmationContext {
  /** How the order-action authorization verified; sponsored mode needs recovery. */
  verifiedVia: "recovery" | "erc1271";
}

export interface ConfirmationOutcome {
  result: Record<string, unknown>;
  /** True when the stored finalized state changed, which moves the capability epoch. */
  finalChanged: boolean;
}

/** The chain client surface the EAS nonce read needs; mocked in tests. */
export interface EasReadClient {
  readContract(args: {
    address: Address;
    abi: typeof easNonceAbi;
    functionName: "getNonce";
    args: readonly [Address];
  }): Promise<bigint>;
}

function invalidRequest(message?: string) {
  return standardRailError("CONFIRMATION_REQUEST_INVALID", message ? { message } : {});
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw invalidRequest(`Expected exactly the fields ${expected.join(", ")}`);
  }
}

function submissionMode(value: unknown): ConfirmationSubmissionMode {
  if (value === "sponsored" || value === "direct") return value;
  throw invalidRequest("submission must be sponsored or direct");
}

function view(observation: ConfirmationFinal) {
  return {
    state: observation.state,
    currentUid: observation.currentUid,
    submissionsUsed: observation.submissionsUsed,
  };
}

function blockView(observation: ConfirmationFinal) {
  return { number: observation.blockNumber, hash: observation.blockHash };
}

export class StandardConfirmations {
  private readonly chainId: number;

  constructor(
    private readonly pool: Pool,
    private readonly config: StandardRailConfig,
    chain: Chain,
    private readonly state: StandardConfirmationState,
    private readonly easClient?: EasReadClient,
  ) {
    this.chainId = chain.id;
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
      throw standardRailError("REPUTATION_UNAVAILABLE");
    }
    throw standardRailError("REPUTATION_NOT_READY");
  }

  async handle(
    order: StandardOrderRecord,
    action: Action,
    request: Record<string, unknown>,
    context: ConfirmationContext,
  ): Promise<ConfirmationOutcome> {
    if (request.phase === "prepare") return this.prepare(order, action, request, context);
    if (request.phase === "submit") return this.submit(order, action, request, context);
    if (request.phase === "check") return this.check(order, request);
    throw invalidRequest("phase must be prepare, submit, or check");
  }

  /** The order's record at `latest`, pinned to that block; the payer must match. */
  private async current(order: StandardOrderRecord): Promise<ConfirmationObservation> {
    let observation: ConfirmationObservation;
    try {
      observation = await this.state.observe(order.orderKey, "latest");
    } catch {
      throw standardRailError("CONFIRMATION_SPONSORSHIP_UNAVAILABLE");
    }
    if (!observation.registered || getAddress(observation.payer) !== getAddress(order.payer!)) {
      throw standardRailError("CONFIRMATION_ORDER_UNAVAILABLE");
    }
    return observation;
  }

  private async easNonce(payer: Address): Promise<bigint> {
    try {
      if (this.easClient) {
        return await this.easClient.readContract({
          address: this.config.easAddress, abi: easNonceAbi, functionName: "getNonce", args: [payer],
        });
      }
      return await this.state.observeWith(({ client }) => (client as unknown as EasReadClient).readContract({
        address: this.config.easAddress, abi: easNonceAbi, functionName: "getNonce", args: [payer],
      }));
    } catch {
      throw standardRailError("CONFIRMATION_SPONSORSHIP_UNAVAILABLE");
    }
  }

  private recipientOf(observation: ConfirmationObservation): Address {
    return observation.providerAgentWallet.toLowerCase() === ZERO_ADDRESS
      ? getAddress(observation.providerOwner)
      : getAddress(observation.providerAgentWallet);
  }

  private attestData(order: StandardOrderRecord, confirmation: "Confirmed" | "NotConfirmed"): Hex {
    return encodeAbiParameters(confirmationPayload, [order.orderKey, confirmation === "Confirmed" ? 1 : 2]);
  }

  private async prepare(
    order: StandardOrderRecord,
    action: Action,
    request: Record<string, unknown>,
    context: ConfirmationContext,
  ): Promise<ConfirmationOutcome> {
    exact(request, [...CONFIRMATION_REQUEST_SHAPES[action].prepare]);
    const mode = submissionMode(request.submission);
    if (action === "confirmation" && request.confirmation !== "Confirmed" &&
      request.confirmation !== "NotConfirmed") throw invalidRequest("confirmation must be Confirmed or NotConfirmed");
    if (action === "confirmation" && typeof request.acknowledgeFinalTransition !== "boolean") {
      throw invalidRequest("acknowledgeFinalTransition must be a boolean");
    }
    if (mode === "sponsored" && context.verifiedVia !== "recovery") {
      throw standardRailError("CONFIRMATION_SPONSORED_REQUIRES_EOA");
    }
    const current = await this.current(order);
    const submissionsUsed = current.submissionsUsed;
    const revocationAvailable = current.currentUid !== ZERO_UID;
    if (action === "revoke-confirmation" && !revocationAvailable) {
      throw standardRailError("CONFIRMATION_NOT_ACTIVE");
    }
    if (action === "confirmation" && submissionsUsed >= CONFIRMATION_ATTESTATION_CAP) {
      throw standardRailError("CONFIRMATION_SUBMISSION_LIMIT");
    }
    // Only the third attestation is final; a revocation never is, and
    // revocation never restores attestation capacity.
    const finalAttestation = action === "confirmation" && submissionsUsed === CONFIRMATION_ATTESTATION_CAP - 1;
    const summary = {
      orderKey: order.orderKey,
      submissionsUsed,
      revocationAvailable,
      finalAttestation,
      ...(finalAttestation ? { warning: FINAL_ATTESTATION_WARNING } : {}),
    };
    if (finalAttestation && request.acknowledgeFinalTransition !== true) {
      return {
        result: mode === "sponsored" ? { ...summary, signableTypedData: null } : { ...summary, call: null },
        finalChanged: false,
      };
    }
    const payer = getAddress(order.payer!);
    const schema = this.config.reputationConfirmationSchemaUid;
    if (mode === "direct") {
      const call = action === "confirmation"
        ? {
            function: "attest" as const,
            request: {
              schema,
              data: {
                recipient: this.recipientOf(current),
                expirationTime: "0",
                revocable: true,
                refUID: current.currentUid,
                data: this.attestData(order, request.confirmation as "Confirmed" | "NotConfirmed"),
                value: "0",
              },
            },
          }
        : {
            function: "revoke" as const,
            request: { schema, data: { uid: current.currentUid, value: "0" } },
          };
      const calldata = call.function === "attest"
        ? encodeFunctionData({
            abi: easDirectAbi,
            functionName: "attest",
            args: [{
              schema,
              data: {
                recipient: call.request.data.recipient as Address,
                expirationTime: 0n,
                revocable: true,
                refUID: current.currentUid,
                data: (call.request.data as { data: Hex }).data,
                value: 0n,
              },
            }],
          })
        : encodeFunctionData({
            abi: easDirectAbi,
            functionName: "revoke",
            args: [{ schema, data: { uid: current.currentUid, value: 0n } }],
          });
      return {
        result: {
          ...summary,
          call: {
            chainId: this.chainId,
            to: this.config.easAddress,
            function: call.function,
            request: call.request,
            calldata,
            value: "0",
          },
          observedBlock: blockView(current),
        },
        finalChanged: false,
      };
    }
    const nonce = await this.easNonce(payer);
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + this.config.confirmationDeadlineSeconds);
    const domain = { name: "EAS", version: "1.2.0", chainId: this.chainId,
      verifyingContract: this.config.easAddress };
    const typedData = action === "confirmation" ? {
      domain, types: attestTypes, primaryType: "Attest" as const,
      message: { schema, recipient: this.recipientOf(current),
        expirationTime: "0", revocable: true, refUID: current.currentUid,
        data: this.attestData(order, request.confirmation as "Confirmed" | "NotConfirmed"),
        value: "0", nonce: nonce.toString(), deadline: deadline.toString() },
    } : {
      domain, types: revokeTypes, primaryType: "Revoke" as const,
      message: { schema, uid: current.currentUid, value: "0", nonce: nonce.toString(),
        deadline: deadline.toString() },
    };
    const preparationId = randomUUID();
    const requestHash = canonicalHash({ orderKey: order.orderKey, operation: action,
      currentUid: current.currentUid, submissionsUsed, nonce: nonce.toString(),
      deadline: deadline.toString(), typedData });
    await this.pool.query(CONFIRMATION_PREPARATION_INSERT_SQL,
      [preparationId, order.orderId, Buffer.from(order.orderKey.slice(2), "hex"), payer.toLowerCase(),
        action === "confirmation" ? "attest-confirmation" : "revoke-confirmation",
        action === "confirmation" ? request.confirmation : null,
        current.currentUid === ZERO_UID ? null : Buffer.from(current.currentUid.slice(2), "hex"),
        submissionsUsed, nonce.toString(), deadline.toString(), Buffer.from(requestHash.slice(2), "hex"),
        typedData, finalAttestation],
    );
    return {
      result: { ...summary, preparationId, currentRefUid: current.currentUid, signableTypedData: typedData },
      finalChanged: false,
    };
  }

  /**
   * Strict delegated-signature validation: the exact stored preparation, a
   * 65-byte low-s signature, recovery to the payer. It runs before any chain
   * read and before any sponsorship reservation, so an invalid signature
   * consumes no budget.
   */
  private async assertDelegatedSignature(
    order: StandardOrderRecord,
    prep: PreparationRow,
    signature: unknown,
  ): Promise<Hex> {
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw standardRailError("CONFIRMATION_SIGNATURE_INVALID");
    }
    try {
      const parts = parseSignature(signature as Hex);
      if (BigInt(parts.s) > HALF_CURVE_ORDER) throw new Error("high-s");
      const recovered = await recoverTypedDataAddress({
        ...prep.canonical_typed_data,
        signature: signature as Hex,
      } as never);
      if (getAddress(recovered) !== getAddress(order.payer!)) throw new Error("payer mismatch");
    } catch {
      throw standardRailError("CONFIRMATION_SIGNATURE_INVALID");
    }
    return signature as Hex;
  }

  private async submit(
    order: StandardOrderRecord,
    action: Action,
    request: Record<string, unknown>,
    context: ConfirmationContext,
  ): Promise<ConfirmationOutcome> {
    exact(request, [...CONFIRMATION_REQUEST_SHAPES[action].submit]);
    if (submissionMode(request.submission) !== "sponsored") {
      throw invalidRequest("submit exists only for sponsored submissions; direct calls are sent by the wallet");
    }
    if (context.verifiedVia !== "recovery") throw standardRailError("CONFIRMATION_SPONSORED_REQUIRES_EOA");
    if (typeof request.preparationId !== "string" || !/^[0-9a-f-]{36}$/i.test(request.preparationId)) {
      throw invalidRequest("preparationId must be the identifier prepare returned");
    }
    const result = await this.pool.query<PreparationRow>(
      "SELECT * FROM standard_confirmation_preparations WHERE preparation_id=$1 AND order_id=$2",
      [request.preparationId, order.orderId],
    );
    const prep = result.rows[0];
    if (!prep || prep.operation !== (action === "confirmation" ? "attest-confirmation" : "revoke-confirmation") ||
      prep.expires_at.getTime() <= Date.now()) throw standardRailError("CONFIRMATION_PREPARATION_STALE");
    if (prep.consumed_at) {
      const existing = await this.pool.query<{ operation_id: string; state: string }>(
        `SELECT o.operation_id,o.state FROM standard_confirmation_sponsorships s
          JOIN standard_reputation_operations o ON o.operation_id=s.operation_id
         WHERE s.preparation_id=$1`, [prep.preparation_id]);
      if (existing.rows[0]) {
        if (["pending", "broadcast", "operator_attention"].includes(existing.rows[0].state)) {
          throw standardRailError("CONFIRMATION_SUBMISSION_PENDING");
        }
        return {
          result: { operationId: existing.rows[0].operation_id, state: existing.rows[0].state },
          finalChanged: false,
        };
      }
      throw standardRailError("CONFIRMATION_PREPARATION_STALE");
    }
    const signature = await this.assertDelegatedSignature(order, prep, request.signature);
    const current = await this.current(order);
    const expectedUid = prep.current_uid ? `0x${prep.current_uid.toString("hex")}` : ZERO_UID;
    const nonce = await this.easNonce(getAddress(order.payer!));
    if (current.submissionsUsed !== Number(prep.submissions_used) ||
      current.currentUid !== expectedUid.toLowerCase() || nonce.toString() !== prep.eas_nonce) {
      throw standardRailError("CONFIRMATION_PREPARATION_STALE");
    }
    await this.reserve(order, prep, signature, current);
    throw standardRailError("CONFIRMATION_SUBMISSION_PENDING");
  }

  private async reserve(
    order: StandardOrderRecord,
    prep: PreparationRow,
    signature: Hex,
    current: ConfirmationObservation,
  ) {
    const attestation = prep.operation === "attest-confirmation";
    const client = await this.pool.connect();
    try {
      // Read committed under the sponsorship lock: every reservation takes this
      // lock before counting, so the counts are already serialized; SERIALIZABLE
      // fixed the snapshot before the lock was granted (see walletStore.issue).
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["confirmation-sponsorship"]);
      // Attestations and revocations are counted separately per order; the
      // per-payer and global daily budgets count every sponsorship.
      const counts = await client.query<{
        order_attestations: string; order_revocations: string; payer_count: string; global_count: string;
      }>(
        `SELECT count(*) FILTER (WHERE s.order_id=$1 AND s.state<>'released'
                  AND p.operation='attest-confirmation')::text AS order_attestations,
                count(*) FILTER (WHERE s.order_id=$1 AND s.state<>'released'
                  AND p.operation='revoke-confirmation')::text AS order_revocations,
                count(*) FILTER (WHERE s.payer=$2 AND s.utc_day=(now() AT TIME ZONE 'UTC')::date
                  AND s.state<>'released')::text AS payer_count,
                count(*) FILTER (WHERE s.utc_day=(now() AT TIME ZONE 'UTC')::date
                  AND s.state<>'released')::text AS global_count
           FROM standard_confirmation_sponsorships s
           JOIN standard_confirmation_preparations p ON p.preparation_id=s.preparation_id`,
        [order.orderId, order.payer!.toLowerCase()]);
      const count = counts.rows[0]!;
      const orderExhausted = attestation
        ? Number(count.order_attestations) >= this.config.confirmationMaxPerOrder
        : Number(count.order_revocations) >= SPONSORED_REVOCATIONS_PER_ORDER;
      if (orderExhausted ||
        Number(count.payer_count) >= this.config.confirmationMaxPerPayerPerDay ||
        Number(count.global_count) >= this.config.confirmationMaxGlobalPerDay) {
        throw standardRailError("CONFIRMATION_SPONSORSHIP_LIMIT", {
          chainEligible: attestation
            ? current.submissionsUsed < CONFIRMATION_ATTESTATION_CAP
            : current.currentUid !== ZERO_UID,
        });
      }
      const parts = parseSignature(signature);
      const message = prep.canonical_typed_data.message;
      const intent: ConfirmationIntent | RevokeConfirmationIntent = attestation ? {
        operation: "attest-confirmation", orderKey: order.orderKey, orderId: order.orderId,
        outcomeId: order.outcomeId, confirmation: prep.confirmation!, submissionsUsed: Number(prep.submissions_used),
        request: { schema: message.schema as Hex,
          data: { recipient: getAddress(String(message.recipient)), expirationTime: "0", revocable: true,
            refUID: message.refUID as Hex, data: message.data as Hex, value: "0" },
          signature: { v: Number(parts.v), r: parts.r, s: parts.s },
          attester: getAddress(order.payer!), deadline: prep.deadline },
      } : {
        operation: "revoke-confirmation", orderKey: order.orderKey, orderId: order.orderId,
        outcomeId: order.outcomeId, submissionsUsed: Number(prep.submissions_used),
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

  /**
   * One finalized read, stored through the B7 rule, and one latest read
   * pinned to its own block hash, returned but never stored.
   */
  private async check(
    order: StandardOrderRecord,
    request: Record<string, unknown>,
  ): Promise<ConfirmationOutcome> {
    exact(request, [...CONFIRMATION_REQUEST_SHAPES.confirmation.check]);
    submissionMode(request.submission);
    let finalized: ConfirmationObservation;
    let latest: ConfirmationObservation;
    try {
      finalized = await this.state.observe(order.orderKey, "finalized");
      latest = await this.state.observe(order.orderKey, "latest");
    } catch {
      throw standardRailError("CONFIRMATION_SPONSORSHIP_UNAVAILABLE");
    }
    if (!finalized.registered || getAddress(finalized.payer) !== getAddress(order.payer!)) {
      throw standardRailError("CONFIRMATION_ORDER_UNAVAILABLE");
    }
    const recorded = await this.state.record(order, finalized);
    if (recorded.changed) await this.state.bumpEpochFor(order.orderId);
    return {
      result: {
        orderKey: order.orderKey,
        lastObserved: view(latest),
        confirmedCurrent: view(recorded.final),
        submissionsUsed: recorded.final.submissionsUsed,
        observedBlock: blockView(latest),
        finalizedBlock: blockView(recorded.final),
      },
      finalChanged: recorded.changed,
    };
  }
}

export { reputationReadsAbi };
