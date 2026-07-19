import { hexToBytes, recoverTypedDataAddress, type Address } from "viem";
import type { Config } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { PaymentSettledEvent } from "../chain/reader.js";
import type { Queries } from "../db/queries.js";
import {
  AgentCardFetchError,
  fetchAgentCard,
  type FetchAgentCardOptions,
} from "../identity/fetch-agent-card.js";
import { sanitizeBuyerName } from "../identity/name.js";
import { logErrorWithId, publicErrorMessage } from "../util/errorWrap.js";
import type {
  Hex,
  PaymentPayload,
  SettlementResponse,
  StoredChallenge,
} from "../types.js";
import {
  isHex32,
  isHexAddress,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "./protocol.js";

export interface SettleInput {
  payload: PaymentPayload;
  challenge: StoredChallenge;
}

export type SettleResult =
  | { ok: true; response: SettlementResponse }
  | {
      ok: false;
      errorReason: string;
      message: string;
      status: number;
      response: SettlementResponse;
    };

// Verify-only result — backs POST /verify. On success, `settleArgs` carry
// the decoded authorization pieces so the companion /settle call can skip
// redoing signature recovery if the facilitator is feeling fancy. `payer`
// is populated as soon as the authorization field parses, so even signature
// failures surface an alleged payer for auditing.
export type VerifyResult =
  | {
      ok: true;
      alreadyPaid: boolean;
      payer: Hex;
      settleArgs: {
        v: number;
        r: Hex;
        s: Hex;
        validAfter: bigint;
        validBefore: bigint;
        nonce: Hex;
      };
    }
  | {
      ok: false;
      errorReason: string;
      message: string;
      status: number;
      payer: Hex;
    };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;

// 10-second safety margin: if the buyer's signed authorization is about to
// expire, reject before burning facilitator gas submitting an auth that
// would revert on-chain as "expired" anyway.
const VALID_BEFORE_BUFFER_SEC = 10n;

function parseSignature(sig: Hex): { v: number; r: Hex; s: Hex } {
  const bytes = hexToBytes(sig);
  if (bytes.length !== 65) throw new Error("signature must be 65 bytes");
  const r = `0x${Buffer.from(bytes.slice(0, 32)).toString("hex")}` as Hex;
  const s = `0x${Buffer.from(bytes.slice(32, 64)).toString("hex")}` as Hex;
  let v = bytes[64];
  if (v < 27) v += 27;
  return { v, r, s };
}

function fail(
  status: number,
  errorReason: string,
  message: string,
  network: "base" | "base-sepolia",
  payer: Hex = ZERO_ADDRESS,
): SettleResult {
  return {
    ok: false,
    errorReason,
    message,
    status,
    response: { success: false, errorReason, transaction: "", network, payer },
  };
}

function failVerify(
  status: number,
  errorReason: string,
  message: string,
  payer: Hex = ZERO_ADDRESS,
): VerifyResult {
  return { ok: false, errorReason, message, status, payer };
}

function storedSettlementResult(
  challenge: StoredChallenge,
  network: Config["network"],
  payer: Hex,
): SettleResult {
  if (challenge.paymentId == null || !challenge.transactionHash) {
    return fail(
      500,
      "paid_challenge_incomplete",
      "paid challenge is missing its canonical settlement",
      network,
      payer,
    );
  }
  return {
    ok: true,
    response: {
      success: true,
      transaction: challenge.transactionHash,
      network,
      payer,
      daski: {
        paymentId: challenge.paymentId.toString(),
        serviceRef: challenge.serviceRef,
        serviceId: challenge.serviceId,
        providerTokenId: challenge.providerTokenId.toString(),
        buyerTokenId: challenge.buyerTokenId.toString(),
        amount: challenge.amount.toString(),
        providerA2AUrl: challenge.providerA2AUrl,
        ...(challenge.quoteId && challenge.quoteSignature
          ? {
              quoteId: challenge.quoteId,
              quoteSignature: challenge.quoteSignature,
            }
          : {}),
      },
    },
  };
}

function validateSettlementEvent(
  challenge: StoredChallenge,
  event: PaymentSettledEvent,
  enforceBuyer: boolean,
): string | null {
  if (event.providerAgentId !== challenge.providerTokenId) {
    return "event providerAgentId does not match challenge";
  }
  if (enforceBuyer && event.buyerAgentId !== challenge.buyerTokenId) {
    return "event buyerAgentId does not match challenge";
  }
  if (event.serviceId.toLowerCase() !== challenge.serviceId.toLowerCase()) {
    return "event serviceId does not match challenge";
  }
  if (event.totalAmount < challenge.amount) {
    return "event totalAmount is less than challenge amount";
  }
  return null;
}

async function persistSettlementEvent(
  queries: Queries,
  challenge: StoredChallenge,
  event: PaymentSettledEvent,
  transactionHash: Hex,
  buyerAgentId?: bigint,
): Promise<boolean> {
  const recorded = await queries.recordChallengePaid(
    challenge.serviceRef,
    event.paymentId,
    transactionHash,
    buyerAgentId,
  );
  if (!recorded) return false;
  await queries.upsertChainEvent({
    paymentId: event.paymentId,
    txHash: transactionHash,
    blockNumber: 0n,
    serviceId: event.serviceId,
    buyerAgentId: event.buyerAgentId,
    providerAgentId: event.providerAgentId,
    amountAtomic: event.totalAmount,
    settledAt: new Date(),
    outcomeCode: null,
    confirmationCode: 0,
    fulfillmentSeconds: null,
    refundedAtomic: 0n,
  });
  return true;
}

function successfulSettlementResult(args: {
  challenge: StoredChallenge;
  event: PaymentSettledEvent;
  transactionHash: Hex;
  network: Config["network"];
  payer: Hex;
  registered?: boolean;
}): SettleResult {
  return {
    ok: true,
    response: {
      success: true,
      transaction: args.transactionHash,
      network: args.network,
      payer: args.payer,
      daski: {
        paymentId: args.event.paymentId.toString(),
        serviceRef: args.challenge.serviceRef,
        serviceId: args.event.serviceId,
        providerTokenId: args.challenge.providerTokenId.toString(),
        buyerTokenId: args.event.buyerAgentId.toString(),
        amount: args.event.totalAmount.toString(),
        providerA2AUrl: args.challenge.providerA2AUrl,
        ...(args.registered !== undefined
          ? { registered: args.registered }
          : {}),
        ...(args.challenge.quoteId && args.challenge.quoteSignature
          ? {
              quoteId: args.challenge.quoteId,
              quoteSignature: args.challenge.quoteSignature,
            }
          : {}),
      },
    },
  };
}

function missingQuoteCommitment(challenge: StoredChallenge): string | null {
  const missing: string[] = [];
  if (!challenge.quoteId) missing.push("quoteId");
  if (!challenge.quoteSignature) missing.push("quoteSignature");
  if (!challenge.quoteExpiresAt) missing.push("quoteExpiresAt");
  if (!challenge.quoteRequestHash) missing.push("quoteRequestHash");
  return missing.length > 0 ? missing.join(", ") : null;
}

/**
 * Validates an x402 `exact` PaymentPayload against a stored challenge
 * without hitting the chain. Covers payload shape, challenge state,
 * authorization binding, signature recovery, and a pre-flight check that
 * the EIP-3009 nonce hasn't already been consumed. Used by POST /verify
 * and as the first phase of verifyAndSettle.
 */
export async function verifyPaymentPayload(
  input: SettleInput,
  config: Config,
  reader: ChainReader,
  now: Date = new Date(),
): Promise<VerifyResult> {
  const { payload, challenge } = input;
  const network = config.network;

  const missingQuote = missingQuoteCommitment(challenge);
  if (missingQuote) {
    return failVerify(
      409,
      "quote_commitment_missing",
      `stored challenge is missing provider quote commitment fields: ${missingQuote}`,
    );
  }

  if (payload.x402Version !== 1) {
    return failVerify(
      400,
      "invalid_x402_version",
      `unsupported x402Version: ${payload.x402Version}`,
    );
  }
  if (payload.scheme !== "exact") {
    return failVerify(
      400,
      "invalid_scheme",
      `unsupported scheme: ${payload.scheme}`,
    );
  }
  if (payload.network !== network) {
    return failVerify(
      400,
      "invalid_network",
      `expected network ${network}, got ${payload.network}`,
    );
  }

  const auth = payload.payload?.authorization;
  const signature = payload.payload?.signature;
  if (!auth || !signature) {
    return failVerify(400, "invalid_payload", "missing authorization or signature");
  }
  if (
    !isHexAddress(auth.from) ||
    !isHexAddress(auth.to) ||
    !isHex32(auth.nonce) ||
    typeof auth.value !== "string" ||
    typeof auth.validAfter !== "string" ||
    typeof auth.validBefore !== "string"
  ) {
    return failVerify(400, "invalid_payload", "malformed authorization fields");
  }

  const payer = auth.from.toLowerCase() as Hex;

  let value: bigint;
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    value = BigInt(auth.value);
    validAfter = BigInt(auth.validAfter);
    validBefore = BigInt(auth.validBefore);
  } catch {
    return failVerify(
      400,
      "invalid_payload",
      "authorization numeric fields must be decimal strings",
      payer,
    );
  }

  // Strict equality (not `<`) — the EIP-3009 `value` is independent from
  // the `amount` we pass to the adapter, so accepting `value > amount`
  // would mean the buyer signed for more than the gateway charges. The
  // on-chain transferWithAuthorization digest also mismatches in that
  // case (it commits to value, not amount), so the facilitator would
  // burn ~150k gas on a guaranteed-revert tx. Tighten here.
  if (value !== challenge.amount) {
    return failVerify(
      402,
      "invalid_exact_evm_payload_authorization_value",
      `authorization value ${value} does not match required ${challenge.amount}`,
      payer,
    );
  }
  if (auth.to.toLowerCase() !== config.paymentRouterAddress.toLowerCase()) {
    return failVerify(
      402,
      "invalid_exact_evm_payload_recipient_mismatch",
      "authorization `to` must be the PaymentRouter",
      payer,
    );
  }
  // Bind `from` to the wallet that the gateway baked into the typed-data
  // when the challenge was issued. Without this, an unrelated wallet
  // could submit their own signed authorization, on-chain settlement
  // would land for them, and the original challenge would be left
  // dangling (eventually expired) — operationally messy and a denial
  // vector for the legitimate caller.
  if (auth.from.toLowerCase() !== challenge.walletAddress.toLowerCase()) {
    return failVerify(
      402,
      "invalid_exact_evm_payload_authorization_from",
      "authorization `from` does not match the wallet bound to this challenge",
      payer,
    );
  }

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: config.usdcName,
        version: config.usdcVersion,
        chainId: config.chainId,
        verifyingContract: config.usdcAddress,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value,
        validAfter,
        validBefore,
        nonce: auth.nonce,
      },
      signature: signature as Hex,
    });
  } catch (err) {
    return failVerify(
      402,
      "invalid_exact_evm_payload_signature",
      publicErrorMessage(
        "verifyPaymentPayload.recoverSignature",
        err,
        "signature recovery failed",
      ),
      payer,
    );
  }
  if (recovered.toLowerCase() !== payer) {
    return failVerify(
      402,
      "invalid_exact_evm_payload_signature",
      "recovered signer does not match authorization.from",
      payer,
    );
  }

  let v: number, r: Hex, s: Hex;
  try {
    ({ v, r, s } = parseSignature(signature as Hex));
  } catch {
    return failVerify(
      400,
      "invalid_payload",
      "malformed signature",
      payer,
    );
  }

  // Idempotent retries still have to prove possession of the original
  // authorization. Time and nonce checks are intentionally skipped after
  // signature and challenge binding succeed because a settled authorization
  // is necessarily consumed and may be retried after its validity window.
  if (challenge.status === "paid") {
    return {
      ok: true,
      alreadyPaid: true,
      payer,
      settleArgs: { v, r, s, validAfter, validBefore, nonce: auth.nonce },
    };
  }
  if (challenge.status === "expired" || challenge.expiresAt < now) {
    return failVerify(
      410,
      "authorization_expired",
      "the payment challenge has expired",
      payer,
    );
  }

  const nowSec = BigInt(Math.floor(now.getTime() / 1000));
  if (validAfter >= nowSec) {
    return failVerify(
      402,
      "invalid_exact_evm_payload_authorization_valid_after",
      "authorization is not yet valid",
      payer,
    );
  }
  if (validBefore <= nowSec + VALID_BEFORE_BUFFER_SEC) {
    return failVerify(
      402,
      "invalid_exact_evm_payload_authorization_valid_before",
      "authorization is expired or too close to expiry",
      payer,
    );
  }

  // Pre-flight nonce check: refuse to forward to the chain if the
  // authorization was already consumed. Previously this swallowed RPC
  // errors and fell through, which let an attacker amplify facilitator
  // gas burn by replaying old (from, nonce) pairs whenever the RPC was
  // flaky — every replay still cost ~150k gas. Now an RPC outage fails
  // the verify so the operator can backoff at the request layer.
  try {
    const used = await reader.authorizationUsed(payer, auth.nonce);
    if (used) {
      return failVerify(
        402,
        "invalid_exact_evm_payload_authorization",
        "EIP-3009 nonce already consumed",
        payer,
      );
    }
  } catch (err) {
    return failVerify(
      503,
      "rpc_unavailable",
      publicErrorMessage(
        "verifyPaymentPayload.authorizationUsed",
        err,
        "unable to verify authorization nonce",
      ),
      payer,
    );
  }

  return {
    ok: true,
    alreadyPaid: false,
    payer,
    settleArgs: { v, r, s, validAfter, validBefore, nonce: auth.nonce },
  };
}

/**
 * Validates an x402 `exact` PaymentPayload against a stored challenge and
 * submits it on-chain via the facilitator wallet. Returns the settlement
 * response (spec shape) along with Daski-specific paymentId/serviceRef.
 * Idempotent: if the challenge is already paid, returns the stored
 * confirmation without hitting the chain again.
 */
async function verifyAndSettleUnlocked(
  input: SettleInput,
  config: Config,
  reader: ChainReader,
  queries: Queries,
  now: Date = new Date(),
): Promise<SettleResult> {
  const { challenge } = input;
  const network = config.network;

  const missingQuote = missingQuoteCommitment(challenge);
  if (missingQuote) {
    return fail(
      409,
      "quote_commitment_missing",
      `stored challenge is missing provider quote commitment fields: ${missingQuote}`,
      network,
    );
  }

  const verified = await verifyPaymentPayload(input, config, reader, now);
  if (!verified.ok) {
    return fail(
      verified.status,
      verified.errorReason,
      verified.message,
      network,
      verified.payer,
    );
  }

  const { payer, settleArgs } = verified;
  if (verified.alreadyPaid) {
    return storedSettlementResult(challenge, network, payer);
  }

  let settlement;
  try {
    settlement = await reader.settlePayment({
      // Wire-level `providerTokenId` on the challenge is the ERC-8004 agentId.
      providerAgentId: challenge.providerTokenId,
      serviceId: challenge.serviceId,
      amount: challenge.amount,
      serviceRef: challenge.serviceRef,
      from: payer,
      validAfter: settleArgs.validAfter,
      validBefore: settleArgs.validBefore,
      nonce: settleArgs.nonce,
      v: settleArgs.v,
      r: settleArgs.r,
      s: settleArgs.s,
    });
  } catch (err) {
    return fail(
      402,
      "unexpected_settle_error",
      publicErrorMessage(
        "verifyAndSettle.settlePayment",
        err,
        "on-chain settlement failed",
      ),
      network,
      payer,
    );
  }

  const event = settlement.event;
  const eventError = validateSettlementEvent(challenge, event, true);
  if (eventError) {
    return fail(
      500,
      "unexpected_settle_error",
      eventError,
      network,
      payer,
    );
  }

  const recorded = await persistSettlementEvent(
    queries,
    challenge,
    event,
    settlement.transactionHash,
  );
  if (!recorded) {
    return fail(
      500,
      "settlement_persistence_conflict",
      "on-chain settlement conflicts with the stored challenge",
      network,
      payer,
    );
  }

  return successfulSettlementResult({
    challenge,
    event,
    transactionHash: settlement.transactionHash,
    network,
    payer,
  });
}

export async function verifyAndSettle(
  input: SettleInput,
  config: Config,
  reader: ChainReader,
  queries: Queries,
  now: Date = new Date(),
): Promise<SettleResult> {
  return queries.withChallengeSettlementLock(
    input.challenge.serviceRef,
    async () => {
      const challenge =
        (await queries.getChallengeByRef(input.challenge.serviceRef)) ??
        input.challenge;
      return verifyAndSettleUnlocked(
        { ...input, challenge },
        config,
        reader,
        queries,
        now,
      );
    },
  );
}

// ── Atomic register-and-settle ───────────────────────────────────────────
//
// Used when the challenge was issued for a buyer that didn't yet have an
// ERC-8004 agent (challenge.buyerTokenId === 0n). The buyer signs both an
// EIP-3009 payment authorization AND a RegisterAgent typed-data; the
// gateway facilitator submits them as one tx via X402Adapter.
// settleWithRegistration. Either both succeed or both revert — the USDC
// payment is the Sybil tax for the registration.

export interface RegistrationDelegation {
  agentURI: string;
  deadline: bigint;
  signature: Hex;
}

/**
 * Optional dependencies for the atomic register-and-settle path. The only
 * extra knob today is a custom Agent Card fetcher (test seam) — production
 * uses the default `fetchAgentCard` to resolve the buyer's display name
 * from `registration.agentURI` after a successful mint, so the
 * `buyer_identities` cache is populated for receipts and dashboards.
 */
export interface VerifyAndSettleWithRegistrationOptions {
  fetchAgentCardFn?: FetchAgentCardOptions["fetchFn"];
}

async function verifyAndSettleWithRegistrationUnlocked(
  input: SettleInput,
  registration: RegistrationDelegation,
  config: Config,
  reader: ChainReader,
  queries: Queries,
  now: Date = new Date(),
  opts: VerifyAndSettleWithRegistrationOptions = {},
): Promise<SettleResult> {
  const { challenge } = input;
  const network = config.network;

  const missingQuote = missingQuoteCommitment(challenge);
  if (missingQuote) {
    return fail(
      409,
      "quote_commitment_missing",
      `stored challenge is missing provider quote commitment fields: ${missingQuote}`,
      network,
    );
  }

  const verified = await verifyPaymentPayload(input, config, reader, now);
  if (!verified.ok) {
    return fail(verified.status, verified.errorReason, verified.message, network, verified.payer);
  }
  const { payer, settleArgs } = verified;
  if (verified.alreadyPaid) {
    return storedSettlementResult(challenge, network, payer);
  }

  let settlement;
  try {
    settlement = await reader.settleWithRegistration({
      providerAgentId: challenge.providerTokenId,
      serviceId: challenge.serviceId,
      amount: challenge.amount,
      serviceRef: challenge.serviceRef,
      from: payer,
      validAfter: settleArgs.validAfter,
      validBefore: settleArgs.validBefore,
      nonce: settleArgs.nonce,
      v: settleArgs.v,
      r: settleArgs.r,
      s: settleArgs.s,
      registration: {
        agentURI: registration.agentURI,
        deadline: registration.deadline,
        signature: registration.signature,
      },
    });
  } catch (err) {
    return fail(
      402,
      "unexpected_settle_error",
      publicErrorMessage(
        "verifyAndSettle.settleWithRegistration",
        err,
        "on-chain atomic register-and-settle failed",
      ),
      network,
      payer,
    );
  }

  const event = settlement.event;
  // We DO NOT enforce event.buyerAgentId === challenge.buyerTokenId here:
  // for atomic flows the challenge stores 0n (unknown) and the on-chain
  // event carries the freshly minted ID. Provider/amount/serviceId checks
  // still hold.
  const eventError = validateSettlementEvent(challenge, event, false);
  if (eventError) {
    return fail(
      500,
      "unexpected_settle_error",
      eventError,
      network,
      payer,
    );
  }

  // Backfill buyer_token_id with the freshly-minted agentId from the
  // PaymentSettled event. The challenge was opened with `buyer_token_id = 0`
  // (atomic-register placeholder); without this update the row stays at 0
  // forever, the activity feed renders `agent#0`, and the public buyer-name
  // resolver has nothing to look up. Safe for settle-only too (where the
  // value already matches), but the atomic path is the case that needs it.
  const recorded = await persistSettlementEvent(
    queries,
    challenge,
    event,
    settlement.transactionHash,
    event.buyerAgentId,
  );
  if (!recorded) {
    return fail(
      500,
      "settlement_persistence_conflict",
      "on-chain settlement conflicts with the stored challenge",
      network,
      payer,
    );
  }

  // Mirror the buyer-name resolution that the /register flow does, so
  // the atomic register-and-settle path also populates buyer_identities.
  // Without this, every fresh-wallet purchase mints an agent on-chain but
  // leaves the cache empty — receipts and dashboards then fall back to
  // walletAddress display until the buyer manually re-registers.
  // Best-effort: failures here log + continue, never block the on-chain
  // settlement that already succeeded.
  if (settlement.registered) {
    try {
      const card = await fetchAgentCard(registration.agentURI, {
        ipfsGatewayUrl: config.ipfsGatewayUrl,
        fetchFn: opts.fetchAgentCardFn,
      });
      const name = sanitizeBuyerName(card.name);
      if (!name.ok) {
        throw new Error(`buyer Agent Card name is invalid: ${name.error}`);
      }
      await queries.upsertBuyerIdentity({
        agentId: event.buyerAgentId,
        walletAddress: payer,
        resolvedName: name.name,
        agentURI: registration.agentURI,
      });
    } catch (err) {
      if (err instanceof AgentCardFetchError) {
        // Couldn't resolve a name — agentURI is malformed, unreachable,
        // or missing the `name` field. Log so operators notice if this
        // is hitting every atomic settle, but don't block.
        logErrorWithId("upsertBuyerIdentityOnAtomic.fetch", err);
      } else {
        logErrorWithId("upsertBuyerIdentityOnAtomic", err);
      }
    }
  }

  return successfulSettlementResult({
    challenge,
    event,
    transactionHash: settlement.transactionHash,
    network,
    payer,
    registered: settlement.registered,
  });
}

export async function verifyAndSettleWithRegistration(
  input: SettleInput,
  registration: RegistrationDelegation,
  config: Config,
  reader: ChainReader,
  queries: Queries,
  now: Date = new Date(),
  opts: VerifyAndSettleWithRegistrationOptions = {},
): Promise<SettleResult> {
  return queries.withChallengeSettlementLock(
    input.challenge.serviceRef,
    async () => {
      const challenge =
        (await queries.getChallengeByRef(input.challenge.serviceRef)) ??
        input.challenge;
      return verifyAndSettleWithRegistrationUnlocked(
        { ...input, challenge },
        registration,
        config,
        reader,
        queries,
        now,
        opts,
      );
    },
  );
}
