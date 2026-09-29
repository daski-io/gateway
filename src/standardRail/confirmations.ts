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
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PostgresFacilitatorNonceLock, type FacilitatorNonceLock } from "./facilitatorNonceLock.js";
import type { Pool } from "../db/pool.js";
import { easProfile, observeEasProfile, EasIncompatible, type EasProfileObservation } from "./easProfiles.js";
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
const BASE_CONFIRMATION_REQUEST_SHAPES = {
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
export const CONFIRMATION_REQUEST_SHAPES = {
  confirmation: {
    prepare: [...BASE_CONFIRMATION_REQUEST_SHAPES.confirmation.prepare, "reviewProtocol"],
    submit: [...BASE_CONFIRMATION_REQUEST_SHAPES.confirmation.submit, "reviewProtocol"],
    check: BASE_CONFIRMATION_REQUEST_SHAPES.confirmation.check,
  },
  "revoke-confirmation": {
    prepare: [...BASE_CONFIRMATION_REQUEST_SHAPES["revoke-confirmation"].prepare, "reviewProtocol"],
    submit: [...BASE_CONFIRMATION_REQUEST_SHAPES["revoke-confirmation"].submit, "reviewProtocol"],
    check: BASE_CONFIRMATION_REQUEST_SHAPES["revoke-confirmation"].check,
  },
} as const;
export const CONFIRMATION_DIRECT_REQUEST_SHAPES = BASE_CONFIRMATION_REQUEST_SHAPES;
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


interface PreparationRow {
  profile_id: "eas-native-1.0.1" | "eas-native-1.2.0";
  signed_deadline: string | null;
  profile_observation: EasProfileObservation | null;
  protocol_v2: boolean;
  authorization_group: string;
  relay_candidate: boolean;
  preparation_id: string;
  order_id: string;
  operation: "attest-confirmation" | "revoke-confirmation";
  confirmation: "Confirmed" | "NotConfirmed" | null;
  current_uid: Buffer | null;
  submissions_used: number;
  eas_nonce: string;
  deadline: string;
  canonical_typed_data: { domain: Record<string, unknown>; types: Record<string, readonly { name: string; type: string }[]>;
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
  /** True when the stored final state changed, which moves the capability epoch. */
  finalChanged: boolean;
}

/** The chain client surface the EAS nonce read needs; mocked in tests. */
export interface EasReadClient {
  readProfile?(): Promise<EasProfileObservation>;
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

/** The closed direct-mode call as the buyer validates it: exactly these six fields, `value` "0". */
export interface DirectConfirmationCall {
  chainId: number;
  to: Address;
  function: "attest" | "revoke";
  request: Record<string, unknown>;
  calldata: Hex;
  value: "0";
}

/**
 * The EAS call a contract-account payer submits itself (spec B6): built from
 * the chain record and the label only, and published as the
 * `confirmation-direct-call.json` wire fixture so the buyer's validator is
 * proved against the exact shape this gateway emits.
 */
export function directConfirmationCall(args: {
  chainId: number;
  easAddress: Address;
  schema: Hex;
  currentUid: Hex;
  action: "attest" | "revoke";
  recipient?: Address;
  data?: Hex;
}): DirectConfirmationCall {
  if (args.action === "attest") {
    if (!args.recipient || !args.data) throw new Error("attest call needs a recipient and data");
    return {
      chainId: args.chainId,
      to: args.easAddress,
      function: "attest",
      request: {
        schema: args.schema,
        data: {
          recipient: args.recipient,
          expirationTime: "0",
          revocable: true,
          refUID: args.currentUid,
          data: args.data,
          value: "0",
        },
      },
      calldata: encodeFunctionData({
        abi: easDirectAbi,
        functionName: "attest",
        args: [{
          schema: args.schema,
          data: {
            recipient: args.recipient,
            expirationTime: 0n,
            revocable: true,
            refUID: args.currentUid,
            data: args.data,
            value: 0n,
          },
        }],
      }),
      value: "0",
    };
  }
  return {
    chainId: args.chainId,
    to: args.easAddress,
    function: "revoke",
    request: { schema: args.schema, data: { uid: args.currentUid, value: "0" } },
    calldata: encodeFunctionData({
      abi: easDirectAbi,
      functionName: "revoke",
      args: [{ schema: args.schema, data: { uid: args.currentUid, value: 0n } }],
    }),
    value: "0",
  };
}

export class StandardConfirmations {
  private readonly chainId: number;

  constructor(
    private readonly pool: Pool,
    private readonly config: StandardRailConfig,
    chain: Chain,
    private readonly state: StandardConfirmationState,
    private readonly easClient?: EasReadClient,
    private readonly reviewLock: FacilitatorNonceLock = new PostgresFacilitatorNonceLock(pool, chain.id, privateKeyToAccount(config.reputationRelayerPrivateKey).address),
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
    if (request.phase === "reaffirm") return this.reviewLock.run(() => this.reaffirm(order, request, context));
    if (request.phase === "prepare") return this.reviewLock.run(() => this.prepare(order, action, request, context));
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

  private async profile(blockTag: "latest" | "safe" | "finalized" = "latest"): Promise<EasProfileObservation> {
    try {
      if (this.easClient?.readProfile) return await this.easClient.readProfile();
      return await this.state.observeWith(({ client }) =>
        observeEasProfile(client as unknown as PublicClient, this.chainId, this.config.easAddress, blockTag));
    } catch (error) {
      throw standardRailError(error instanceof EasIncompatible
        ? "CONFIRMATION_EAS_INCOMPATIBLE" : "CONFIRMATION_SPONSORSHIP_UNAVAILABLE");
    }
  }

  private async reaffirm(order: StandardOrderRecord, request: Record<string, unknown>, context: ConfirmationContext): Promise<ConfirmationOutcome> {
    exact(request, ["phase", "submission", "reviewProtocol", "operationId"]);
    if (request.reviewProtocol !== 2) throw standardRailError("CONFIRMATION_CLIENT_UPGRADE_REQUIRED");
    if (request.submission !== "sponsored" || context.verifiedVia !== "recovery" ||
        typeof request.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.operationId)) throw invalidRequest();
    const profile = await this.profile();
    const nonce = await this.easNonce(getAddress(order.payer!));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('confirmation-prepare:' || $1::text,0))", [order.payer!.toLowerCase()]);
      await this.assertUnpaused(client);
      const row = await client.query<{ state: string; eas_nonce: string; profile_id: string; relay_candidate: boolean; signed_deadline: string | null; attempts: number }>(`
        SELECT o.state,o.attempts,p.eas_nonce,p.profile_id,p.relay_candidate,p.signed_deadline
          FROM standard_reputation_operations o JOIN standard_confirmation_sponsorships_v2 s USING(operation_id)
          JOIN standard_confirmation_preparations_v2 p USING(preparation_id)
          WHERE o.operation_id=$1 AND o.order_id=$2 AND p.payer=$3 FOR UPDATE OF o,p`,
        [request.operationId,order.orderId,order.payer!.toLowerCase()]);
      const op = row.rows[0];
      if (!op || !op.relay_candidate || op.signed_deadline !== null || op.profile_id !== profile.profileId ||
          op.eas_nonce !== nonce.toString() || !["authorization_live", "pending", "broadcast"].includes(op.state) || op.attempts >= 5)
        throw standardRailError("CONFIRMATION_AUTHORIZATION_STILL_LIVE", { expected: { operationId: request.operationId, safeRetired: false } });
      await client.query(`UPDATE standard_reputation_operations SET state='pending',next_attempt_at=now(),
        review_relay_until=now()+($2::text||' seconds')::interval,updated_at=now() WHERE operation_id=$1`,
        [request.operationId,this.config.confirmationDeadlineSeconds]);
      await client.query(`INSERT INTO standard_operator_actions(actor,action,target_id,details)
        VALUES ('payer','review_reaffirm',$1,$2)`, [request.operationId,{ orderId: order.orderId }]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
    throw standardRailError("CONFIRMATION_SUBMISSION_PENDING", { expected: { operationId: request.operationId, disposition: "pending" } });
  }

  private async assertUnpaused(client: { query: Pool["query"] } = this.pool): Promise<void> {
    const control = await client.query<{ paused: boolean }>("SELECT paused FROM standard_review_control WHERE chain_id=$1", [this.chainId]);
    if (control.rows[0]?.paused) throw standardRailError("CONFIRMATION_REVIEWS_PAUSED");
  }

  /** The attestation recipient is the record's provider agent wallet; the contract registers no zero wallet. */
  private recipientOf(observation: ConfirmationObservation): Address {
    if (observation.providerAgentWallet.toLowerCase() === ZERO_ADDRESS) {
      throw standardRailError("CONFIRMATION_ORDER_UNAVAILABLE");
    }
    return getAddress(observation.providerAgentWallet);
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
    const mode = submissionMode(request.submission);
    const extras: string[] = [];
    if (mode === "sponsored") {
      if (request.reviewProtocol !== 2) throw standardRailError("CONFIRMATION_CLIENT_UPGRADE_REQUIRED");
      extras.push("reviewProtocol");
      if (request.supersedesOperationId !== undefined || request.supersedesPreparationId !== undefined) {
        if (request.acknowledgeSameNonce !== true ||
          (request.supersedesOperationId !== undefined && request.supersedesPreparationId !== undefined)) throw invalidRequest("Explicit same-nonce acknowledgement and one predecessor are required");
        const field = request.supersedesOperationId !== undefined ? "supersedesOperationId" : "supersedesPreparationId";
        if (typeof request[field] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(request[field]))) throw invalidRequest("Invalid predecessor identifier");
        extras.push(field, "acknowledgeSameNonce");
      }
      await this.assertUnpaused();
    }
    exact(request, [...BASE_CONFIRMATION_REQUEST_SHAPES[action].prepare, ...extras]);
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
      const call = directConfirmationCall({
        chainId: this.chainId,
        easAddress: this.config.easAddress,
        schema,
        currentUid: current.currentUid,
        action: action === "confirmation" ? "attest" : "revoke",
        ...(action === "confirmation" ? {
          recipient: this.recipientOf(current),
          data: this.attestData(order, request.confirmation as "Confirmed" | "NotConfirmed"),
        } : {}),
      });
      return {
        result: { ...summary, call, observedBlock: blockView(current) },
        finalChanged: false,
      };
    }
    const profile = await this.profile();
    const nonce = await this.easNonce(payer);
    const oldIssued = await this.pool.query<{deadline:string}>(`SELECT deadline FROM standard_confirmation_preparations
      WHERE payer=$1 AND eas_nonce=$2::numeric AND consumed_at IS NULL`,[payer.toLowerCase(),nonce.toString()]);
    if (oldIssued.rowCount) {
      const final = await this.profile(this.config.finalityTag);
      if (oldIssued.rows.some(p => BigInt(p.deadline) >= BigInt(final.timestamp)))
        throw standardRailError("CONFIRMATION_NONCE_BUSY", { expected: { disposition:"historical-issued-authorization" } });
    }
    const prepared = await this.preparationFor({
      order, action, payer, nonce, schema, current, submissionsUsed, finalAttestation, profile,
      supersedesOperationId: request.supersedesOperationId as string | undefined,
      supersedesPreparationId: request.supersedesPreparationId as string | undefined,
      confirmation: action === "confirmation" ? request.confirmation as "Confirmed" | "NotConfirmed" : null,
    });
    return {
      result: { ...summary, preparationId: prepared.preparationId, currentRefUid: current.currentUid,
        signableTypedData: prepared.typedData, profileId: profile.profileId, profileObservation: profile,
        contractVersion: profile.contractVersion, domainVersion: profile.domainVersion,
        signedDeadline: prepared.typedData.message.deadline ?? null,
        admissionExpiresAt: prepared.admissionExpiresAt },
      finalChanged: false,
    };
  }

  /** Explicit same-nonce replacements retain every authorization and its shared allowance. */
  private async preparationFor(args: {
    profile: EasProfileObservation;
    supersedesOperationId?: string;
    supersedesPreparationId?: string;
    order: StandardOrderRecord;
    action: Action;
    payer: Address;
    nonce: bigint;
    schema: Hex;
    current: ConfirmationObservation;
    submissionsUsed: number;
    finalAttestation: boolean;
    confirmation: "Confirmed" | "NotConfirmed" | null;
  }): Promise<{ preparationId: string; typedData: PreparationRow["canonical_typed_data"]; admissionExpiresAt: string }> {
    const { order, action, payer, nonce, schema, current, submissionsUsed, finalAttestation } = args;
    const operation = action === "confirmation" ? "attest-confirmation" : "revoke-confirmation";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('confirmation-prepare:' || $1::text, 0))",
        [payer.toLowerCase()],
      );
      await this.assertUnpaused(client);
      let predecessor: PreparationRow | undefined;
      if (args.supersedesOperationId || args.supersedesPreparationId) {
        const prior = await client.query<PreparationRow>(`SELECT p.* FROM standard_review_preparations p
          LEFT JOIN standard_review_sponsorships s ON s.preparation_id=p.preparation_id
          WHERE p.payer=$1 AND p.eas_nonce=$2::numeric AND
            (($3::uuid IS NOT NULL AND s.operation_id=$3) OR ($4::uuid IS NOT NULL AND p.preparation_id=$4))
`, [payer.toLowerCase(), nonce.toString(), args.supersedesOperationId ?? null, args.supersedesPreparationId ?? null]);
        predecessor = prior.rows[0];
        if (!predecessor || !predecessor.protocol_v2 || predecessor.profile_id !== args.profile.profileId)
          throw standardRailError("CONFIRMATION_PREPARATION_STALE");
        // A repeated explicit replacement resumes the existing candidate.
        const replacement = await client.query<PreparationRow>(`SELECT * FROM standard_confirmation_preparations_v2
          WHERE supersedes_preparation_id=$1 AND relay_candidate=true ORDER BY created_at DESC LIMIT 1`,
          [predecessor.preparation_id]);
        if (replacement.rows[0]) {
          const r = replacement.rows[0];
          if (r.order_id !== order.orderId || r.confirmation !== args.confirmation || r.operation !== operation)
            throw standardRailError("CONFIRMATION_AUTHORIZATION_STILL_LIVE");
          await client.query("COMMIT");
          return { preparationId: r.preparation_id, typedData: r.canonical_typed_data, admissionExpiresAt: r.expires_at.toISOString() };
        }
        await client.query(`UPDATE standard_confirmation_preparations_v2 SET relay_candidate=false,consumed_at=COALESCE(consumed_at,now())
          WHERE authorization_group=$1`, [predecessor.authorization_group]);
        await client.query(`UPDATE standard_reputation_operations SET state='superseded',next_attempt_at=NULL,updated_at=now()
          WHERE operation_id IN (SELECT s.operation_id FROM standard_confirmation_sponsorships_v2 s
            JOIN standard_confirmation_preparations_v2 p ON p.preparation_id=s.preparation_id WHERE p.authorization_group=$1)
          AND state IN ('pending','broadcast','operator_attention','authorization_live')`, [predecessor.authorization_group]);
      }
      await this.assertNonceUnoccupied(client, payer, nonce, order.orderId, predecessor?.authorization_group);
      const live = await client.query<PreparationRow>(
        `SELECT * FROM standard_confirmation_preparations_v2
          WHERE payer=$1 AND eas_nonce=$2::numeric AND consumed_at IS NULL
          FOR UPDATE`,
        [payer.toLowerCase(), nonce.toString()],
      );
      const existing = live.rows[0];
      if (existing) {
        const existingUid = existing.current_uid ? `0x${existing.current_uid.toString("hex")}` : ZERO_UID;
        const equivalent = existing.order_id === order.orderId && existing.operation === operation &&
          existing.confirmation === args.confirmation && existingUid === current.currentUid.toLowerCase() &&
          Number(existing.submissions_used) === submissionsUsed &&
          existing.final_transition_acknowledged === finalAttestation;
        if (equivalent) {
          await client.query("COMMIT");
          return { preparationId: existing.preparation_id, typedData: existing.canonical_typed_data, admissionExpiresAt: existing.expires_at.toISOString() };
        }
        throw standardRailError("CONFIRMATION_AUTHORIZATION_STILL_LIVE", {
          expected: { preparationId: existing.preparation_id, safeRetired: false },
        });
      }
      const deadline = BigInt(Math.floor(Date.now() / 1_000) + this.config.confirmationDeadlineSeconds);
      const profile = easProfile(args.profile.profileId);
      const domain = { name: "EAS", version: profile.domainVersion, chainId: this.chainId,
        verifyingContract: this.config.easAddress };
      const typedData = action === "confirmation" ? {
        domain, types: profile.attestTypes, primaryType: "Attest" as const,
        message: { schema, recipient: this.recipientOf(current),
          expirationTime: "0", revocable: true, refUID: current.currentUid,
          data: this.attestData(order, args.confirmation!),
          value: "0", nonce: nonce.toString(), deadline: deadline.toString() },
      } : {
        domain, types: profile.revokeTypes, primaryType: "Revoke" as const,
        message: { schema, uid: current.currentUid, value: "0", nonce: nonce.toString(),
          deadline: deadline.toString() },
      };
      if (!profile.signedDeadline) {
        delete (typedData.message as Record<string, unknown>).value;
        delete (typedData.message as Record<string, unknown>).deadline;
      }
      const preparationId = randomUUID();
      const requestHash = canonicalHash({ orderKey: order.orderKey, operation: action,
        currentUid: current.currentUid, submissionsUsed, nonce: nonce.toString(),
        deadline: deadline.toString(), typedData });
      await client.query(`INSERT INTO standard_confirmation_preparations_v2
        (preparation_id,order_id,order_key,payer,operation,confirmation,current_uid,submissions_used,
         eas_nonce,deadline,request_hash,canonical_typed_data,final_transition_acknowledged,expires_at,
         profile_id,signed_deadline,profile_observation,supersedes_preparation_id,authorization_group)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::bigint,$11,$12,$13,to_timestamp($10::double precision),
          $14,$15::bigint,$16,$17,$18)`,
        [preparationId, order.orderId, Buffer.from(order.orderKey.slice(2), "hex"), payer.toLowerCase(),
          operation, args.confirmation,
          current.currentUid === ZERO_UID ? null : Buffer.from(current.currentUid.slice(2), "hex"),
          submissionsUsed, nonce.toString(), deadline.toString(), Buffer.from(requestHash.slice(2), "hex"),
          typedData, finalAttestation, profile.id, profile.signedDeadline ? deadline.toString() : null,
          args.profile, predecessor?.preparation_id ?? null, predecessor?.authorization_group ?? preparationId],
      );
      await client.query("COMMIT");
      return { preparationId, typedData: typedData as PreparationRow["canonical_typed_data"],
        admissionExpiresAt: new Date(Number(deadline) * 1000).toISOString() };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
    exact(request, [...BASE_CONFIRMATION_REQUEST_SHAPES[action].submit, ...(request.reviewProtocol === 2 ? ["reviewProtocol"] : [])]);
    if (submissionMode(request.submission) !== "sponsored") {
      throw invalidRequest("submit exists only for sponsored submissions; direct calls are sent by the wallet");
    }
    if (context.verifiedVia !== "recovery") throw standardRailError("CONFIRMATION_SPONSORED_REQUIRES_EOA");
    if (
      typeof request.preparationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.preparationId)
    ) {
      throw invalidRequest("preparationId must be the identifier prepare returned");
    }
    const result = await this.pool.query<PreparationRow>(
      "SELECT * FROM standard_review_preparations WHERE preparation_id=$1 AND order_id=$2",
      [request.preparationId, order.orderId],
    );
    const prep = result.rows[0];
    if (!prep || prep.operation !== (action === "confirmation" ? "attest-confirmation" : "revoke-confirmation")) {
      throw standardRailError("CONFIRMATION_PREPARATION_STALE");
    }
    // A consumed preparation answers for its admitted operation whatever its
    // deadline says: the deadline bounds the EAS delegation, not the queued
    // submission, and a buyer resuming after it must learn the operation's
    // state rather than clear its journal and prepare a competing review.
    if (prep.consumed_at) {
      const existing = await this.pool.query<{ operation_id: string; state: string; result: Record<string, unknown> | null }>(
        `SELECT o.operation_id,o.state,o.result FROM standard_review_sponsorships s
          JOIN standard_reputation_operations o ON o.operation_id=s.operation_id
         WHERE s.preparation_id=$1`, [prep.preparation_id]);
      if (existing.rows[0]) {
        const op = existing.rows[0];
        if (["authorization_live", "superseded"].includes(op.state) ||
            (op.state === "operator_attention" && prep.signed_deadline === null)) {
          throw standardRailError("CONFIRMATION_AUTHORIZATION_STILL_LIVE", { expected: { operationId: op.operation_id, safeRetired: false } });
        }
        if (["pending", "broadcast", "operator_attention"].includes(op.state)) {
          throw standardRailError("CONFIRMATION_SUBMISSION_PENDING", { expected: { operationId: op.operation_id, disposition: op.state } });
        }
        if (op.state !== "final") throw standardRailError("CONFIRMATION_SUBMISSION_FAILED", {
          expected: { operationId: op.operation_id, disposition: op.state, safeRetired: op.result?.safeRetired === true },
        });
        return {
          result: { operationId: existing.rows[0].operation_id, state: existing.rows[0].state },
          finalChanged: false,
        };
      }
      throw standardRailError("CONFIRMATION_PREPARATION_STALE");
    }
    if (!prep.protocol_v2 || request.reviewProtocol !== 2) throw standardRailError("CONFIRMATION_CLIENT_UPGRADE_REQUIRED");
    await this.assertUnpaused();
    const liveProfile = await this.profile();
    if (liveProfile.profileId !== prep.profile_id) throw standardRailError("CONFIRMATION_EAS_INCOMPATIBLE");
    if (prep.expires_at.getTime() <= Date.now()) throw standardRailError(
      prep.signed_deadline === null ? "CONFIRMATION_AUTHORIZATION_STILL_LIVE" : "CONFIRMATION_PREPARATION_STALE",
      { expected: { preparationId: prep.preparation_id, safeRetired: false } });
    const signature = await this.assertDelegatedSignature(order, prep, request.signature);
    const current = await this.current(order);
    const expectedUid = prep.current_uid ? `0x${prep.current_uid.toString("hex")}` : ZERO_UID;
    const nonce = await this.easNonce(getAddress(order.payer!));
    if (current.submissionsUsed !== Number(prep.submissions_used) ||
      current.currentUid !== expectedUid.toLowerCase() || nonce.toString() !== prep.eas_nonce) {
      throw standardRailError("CONFIRMATION_PREPARATION_STALE");
    }
    const admitted = await this.reserve(order, prep, signature, current);
    throw standardRailError("CONFIRMATION_SUBMISSION_PENDING", { expected: { operationId: admitted.operationId, disposition: "pending" } });
  }

  /**
   * An admitted sponsored submission holds the payer's EAS nonce until it is
   * mined, whatever the preparation row says: EAS increments the nonce inside
   * `_verifyAttest`, so a second preparation at the same nonce would be
   * admitted, revert on chain, and burn its sponsorship. Under the payer lock,
   * an operation still pending, broadcast, or awaiting an operator at
   * (payer, nonce) refuses a new preparation and a new reservation: the same
   * order waits for its queued submission, another order is busy.
   */
  private async assertNonceUnoccupied(
    client: { query: Pool["query"] },
    payer: Address,
    nonce: bigint,
    orderId: string,
    allowedGroup?: string,
  ): Promise<void> {
    const inFlight = await client.query<{ order_id: string; operation_id: string; signed_deadline: string | null }>(
      `SELECT p.order_id,o.operation_id,p.signed_deadline FROM standard_review_sponsorships s
         JOIN standard_review_preparations p ON p.preparation_id=s.preparation_id
         JOIN standard_reputation_operations o ON o.operation_id=s.operation_id
        WHERE p.payer=$1 AND p.eas_nonce=$2::numeric
          AND o.state IN ('pending','broadcast','operator_attention','authorization_live','superseded')
          AND ($3::uuid IS NULL OR p.authorization_group<>$3)
        LIMIT 1`,
      [payer.toLowerCase(), nonce.toString(), allowedGroup ?? null],
    );
    const held = inFlight.rows[0];
    if (!held) return;
    if (held.signed_deadline === null) throw standardRailError("CONFIRMATION_AUTHORIZATION_STILL_LIVE", {
      expected: { operationId: held.operation_id, safeRetired: false },
    });
    if (held.order_id === orderId) throw standardRailError("CONFIRMATION_SUBMISSION_PENDING", { expected: { operationId: held.operation_id } });
    throw standardRailError("CONFIRMATION_NONCE_BUSY", {
      message: "A sponsored submission for another of this payer's orders is queued at the same EAS nonce",
    });
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
      // Lock order: the payer's preparation lock first (the lock prepare takes
      // to retire and replace preparations), then the global sponsorship
      // lock. A replacement cannot slip between this submission's validation
      // and its reservation, and the two locks are never taken in the
      // opposite order anywhere.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('confirmation-prepare:' || $1::text, 0))",
        [order.payer!.toLowerCase()],
      );
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["confirmation-sponsorship"]);
      await this.assertUnpaused(client);
      // The preparation is re-read under the locks: a prepare that retired it
      // while the signature and chain checks ran wins, and a duplicate submit
      // of the same preparation is answered as pending rather than reserved
      // twice.
      const held = await client.query<{ consumed_at: Date | null; expires_at: Date }>(
        "SELECT consumed_at,expires_at FROM standard_confirmation_preparations_v2 WHERE preparation_id=$1 FOR UPDATE",
        [prep.preparation_id],
      );
      const live = held.rows[0];
      if (!live || live.expires_at.getTime() <= Date.now()) throw standardRailError("CONFIRMATION_PREPARATION_STALE");
      if (live.consumed_at) {
        const sponsored = await client.query(
          "SELECT 1 FROM standard_confirmation_sponsorships_v2 WHERE preparation_id=$1", [prep.preparation_id]);
        throw standardRailError(sponsored.rowCount ? "CONFIRMATION_SUBMISSION_PENDING" : "CONFIRMATION_PREPARATION_STALE");
      }
      await this.assertNonceUnoccupied(client, getAddress(order.payer!), BigInt(prep.eas_nonce), order.orderId, prep.authorization_group);
      // Attestations and revocations are counted separately per order; the
      // per-payer and global daily budgets count every sponsorship.
      const counts = await client.query<{
        order_attestations: string; order_revocations: string; payer_count: string; global_count: string;
      }>(
        `SELECT count(DISTINCT p.authorization_group) FILTER (WHERE s.order_id=$1 AND s.state<>'released'
                  AND p.operation='attest-confirmation')::text AS order_attestations,
                count(DISTINCT p.authorization_group) FILTER (WHERE s.order_id=$1 AND s.state<>'released'
                  AND p.operation='revoke-confirmation')::text AS order_revocations,
                count(DISTINCT p.authorization_group) FILTER (WHERE s.payer=$2 AND s.utc_day=(now() AT TIME ZONE 'UTC')::date
                  AND s.state<>'released')::text AS payer_count,
                count(DISTINCT p.authorization_group) FILTER (WHERE s.utc_day=(now() AT TIME ZONE 'UTC')::date
                  AND s.state<>'released')::text AS global_count
           FROM standard_review_sponsorships s
           JOIN standard_review_preparations p ON p.preparation_id=s.preparation_id
          WHERE (s.order_id=$1 OR s.utc_day=(now() AT TIME ZONE 'UTC')::date) AND p.authorization_group<>$3`,
        [order.orderId, order.payer!.toLowerCase(), prep.authorization_group]);
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
        profileId: prep.profile_id, easNonce: prep.eas_nonce,
        operation: "attest-confirmation", orderKey: order.orderKey, orderId: order.orderId,
        outcomeId: order.outcomeId, confirmation: prep.confirmation!, submissionsUsed: Number(prep.submissions_used),
        request: { schema: message.schema as Hex,
          data: { recipient: getAddress(String(message.recipient)), expirationTime: "0", revocable: true,
            refUID: message.refUID as Hex, data: message.data as Hex, value: "0" },
          signature: { v: Number(parts.v), r: parts.r, s: parts.s },
          attester: getAddress(order.payer!), deadline: prep.signed_deadline },
      } : {
        profileId: prep.profile_id, easNonce: prep.eas_nonce,
        operation: "revoke-confirmation", orderKey: order.orderKey, orderId: order.orderId,
        outcomeId: order.outcomeId, submissionsUsed: Number(prep.submissions_used),
        request: { schema: message.schema as Hex, data: { uid: message.uid as Hex, value: "0" },
          signature: { v: Number(parts.v), r: parts.r, s: parts.s },
          revoker: getAddress(order.payer!), deadline: prep.signed_deadline },
      };
      const operationId = randomUUID();
      const logicalKey = canonicalHash({ preparationId: prep.preparation_id, operation: prep.operation });
      const intentHash = canonicalHash(intent);
      await client.query(
        `INSERT INTO standard_reputation_operations
          (operation_id,order_id,kind,logical_key,intent_hash,canonical_intent,state,next_attempt_at,review_relay_until)
         VALUES ($1,$2,'confirmation-v2',$3,$4,$5,'pending',now(),$6)`,
        [operationId, order.orderId, Buffer.from(logicalKey.slice(2), "hex"),
          Buffer.from(intentHash.slice(2), "hex"), intent, prep.expires_at],
      );
      await client.query(
        `INSERT INTO standard_confirmation_sponsorships_v2
          (preparation_id,operation_id,order_id,payer,utc_day,state)
         VALUES ($1,$2,$3,$4,(now() AT TIME ZONE 'UTC')::date,'reserved')`,
        [prep.preparation_id, operationId, order.orderId, order.payer!.toLowerCase()],
      );
      await client.query(
        "UPDATE standard_confirmation_preparations_v2 SET consumed_at=now() WHERE preparation_id=$1 AND consumed_at IS NULL",
        [prep.preparation_id]);
      await client.query("COMMIT");
      return { operationId, state: "pending" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  /**
   * One read at the configured finality tag, stored through the B7 rule, and one latest read
   * pinned to its own block hash, returned but never stored.
   */
  private async check(
    order: StandardOrderRecord,
    request: Record<string, unknown>,
  ): Promise<ConfirmationOutcome> {
    exact(request, [...BASE_CONFIRMATION_REQUEST_SHAPES.confirmation.check]);
    submissionMode(request.submission);
    let finalized: ConfirmationObservation;
    let latest: ConfirmationObservation;
    try {
      finalized = await this.state.observeFinal(order.orderKey);
      latest = await this.state.observe(order.orderKey, "latest");
    } catch {
      throw standardRailError("CONFIRMATION_SPONSORSHIP_UNAVAILABLE");
    }
    if (!finalized.registered || getAddress(finalized.payer) !== getAddress(order.payer!)) {
      throw standardRailError("CONFIRMATION_ORDER_UNAVAILABLE");
    }
    const recorded = await this.state.record(order, finalized);
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
