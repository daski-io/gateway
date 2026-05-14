import { hexToBytes, recoverTypedDataAddress, type Address } from "viem";
import type { Config } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { Queries } from "../db/queries.js";
import {
  AgentCardFetchError,
  fetchAgentCard,
  type FetchAgentCardOptions,
} from "../identity/fetch-agent-card.js";
import { logErrorWithId } from "../util/errorWrap.js";
import type {
  Hex,
  PaymentPayload,
  SettlementResponse,
  StoredChallenge,
} from "../types.js";

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

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

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

function isHex66(x: string): x is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(x);
}

function isHex42(x: string): x is Hex {
  return /^0x[0-9a-fA-F]{40}$/.test(x);
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
    !isHex42(auth.from) ||
    !isHex42(auth.to) ||
    !isHex66(auth.nonce) ||
    typeof auth.value !== "string" ||
    typeof auth.validAfter !== "string" ||
    typeof auth.validBefore !== "string"
  ) {
    return failVerify(400, "invalid_payload", "malformed authorization fields");
  }

  const payer = auth.from.toLowerCase() as Hex;

  // Idempotent: an already-paid challenge is considered valid. The /verify
  // endpoint returns isValid=true here; /settle short-circuits to the
  // stored settlement response rather than re-submitting.
  if (challenge.status === "paid") {
    let validAfter: bigint;
    let validBefore: bigint;
    try {
      validAfter = BigInt(auth.validAfter);
      validBefore = BigInt(auth.validBefore);
    } catch {
      validAfter = 0n;
      validBefore = 0n;
    }
    return {
      ok: true,
      alreadyPaid: true,
      payer,
      settleArgs: {
        v: 0,
        r: ("0x" + "00".repeat(32)) as Hex,
        s: ("0x" + "00".repeat(32)) as Hex,
        validAfter,
        validBefore,
        nonce: auth.nonce,
      },
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
      `signature recovery failed: ${(err as Error).message}`,
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
      `unable to verify authorization nonce: ${(err as Error).message}`,
      payer,
    );
  }

  let v: number, r: Hex, s: Hex;
  try {
    ({ v, r, s } = parseSignature(signature as Hex));
  } catch (err) {
    return failVerify(
      400,
      "invalid_payload",
      `malformed signature: ${(err as Error).message}`,
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
export async function verifyAndSettle(
  input: SettleInput,
  config: Config,
  reader: ChainReader,
  queries: Queries,
  now: Date = new Date(),
): Promise<SettleResult> {
  const { challenge } = input;
  const network = config.network;

  // Short-circuit idempotent already-paid case before running full
  // validation — the stored settlement is canonical.
  if (
    challenge.status === "paid" &&
    challenge.paymentId != null &&
    challenge.transactionHash
  ) {
    const payer =
      (input.payload.payload?.authorization?.from?.toLowerCase() as Hex) ??
      ZERO_ADDRESS;
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
        },
      },
    };
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
      `on-chain settlement reverted: ${(err as Error).message}`,
      network,
      payer,
    );
  }

  const event = settlement.event;
  if (event.providerAgentId !== challenge.providerTokenId) {
    return fail(
      500,
      "unexpected_settle_error",
      "event providerAgentId does not match challenge",
      network,
      payer,
    );
  }
  if (event.buyerAgentId !== challenge.buyerTokenId) {
    return fail(
      500,
      "unexpected_settle_error",
      "event buyerAgentId does not match challenge",
      network,
      payer,
    );
  }
  // Cross-check serviceId against the value the gateway computed at
  // challenge issuance. The contract enforces consistency too (settle
  // reverts if the serviceId argument doesn't match a registered service
  // for the provider), but a mismatch here would mean the adapter call
  // args were tampered between simulate and broadcast — surface as a
  // 500 rather than silently trusting the event.
  if (
    event.serviceId.toLowerCase() !== challenge.serviceId.toLowerCase()
  ) {
    return fail(
      500,
      "unexpected_settle_error",
      "event serviceId does not match challenge",
      network,
      payer,
    );
  }
  if (event.totalAmount < challenge.amount) {
    return fail(
      500,
      "unexpected_settle_error",
      "event totalAmount is less than challenge amount",
      network,
      payer,
    );
  }

  await queries.recordChallengePaid(
    challenge.serviceRef,
    event.paymentId,
    settlement.transactionHash,
  );

  return {
    ok: true,
    response: {
      success: true,
      transaction: settlement.transactionHash,
      network,
      payer,
      daski: {
        paymentId: event.paymentId.toString(),
        serviceRef: challenge.serviceRef,
        serviceId: event.serviceId,
        providerTokenId: challenge.providerTokenId.toString(),
        buyerTokenId: challenge.buyerTokenId.toString(),
        amount: event.totalAmount.toString(),
        providerA2AUrl: challenge.providerA2AUrl,
      },
    },
  };
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

export async function verifyAndSettleWithRegistration(
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

  // Idempotent already-paid case mirrors verifyAndSettle. If a challenge
  // somehow ends up `paid` here it means a previous atomic settle already
  // completed — return the stored result instead of re-submitting.
  if (
    challenge.status === "paid" &&
    challenge.paymentId != null &&
    challenge.transactionHash
  ) {
    const payer =
      (input.payload.payload?.authorization?.from?.toLowerCase() as Hex) ??
      ZERO_ADDRESS;
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
        },
      },
    };
  }

  const verified = await verifyPaymentPayload(input, config, reader, now);
  if (!verified.ok) {
    return fail(verified.status, verified.errorReason, verified.message, network, verified.payer);
  }
  const { payer, settleArgs } = verified;

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
      `on-chain atomic register-and-settle reverted: ${(err as Error).message}`,
      network,
      payer,
    );
  }

  const event = settlement.event;
  // We DO NOT enforce event.buyerAgentId === challenge.buyerTokenId here:
  // for atomic flows the challenge stores 0n (unknown) and the on-chain
  // event carries the freshly minted ID. Provider/amount/serviceId checks
  // still hold.
  if (event.providerAgentId !== challenge.providerTokenId) {
    return fail(
      500,
      "unexpected_settle_error",
      "event providerAgentId does not match challenge",
      network,
      payer,
    );
  }
  if (
    event.serviceId.toLowerCase() !== challenge.serviceId.toLowerCase()
  ) {
    return fail(
      500,
      "unexpected_settle_error",
      "event serviceId does not match challenge",
      network,
      payer,
    );
  }
  if (event.totalAmount < challenge.amount) {
    return fail(
      500,
      "unexpected_settle_error",
      "event totalAmount is less than challenge amount",
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
  await queries.recordChallengePaid(
    challenge.serviceRef,
    event.paymentId,
    settlement.transactionHash,
    event.buyerAgentId,
  );

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
      await queries.upsertBuyerIdentity({
        agentId: event.buyerAgentId,
        walletAddress: payer,
        resolvedName: card.name,
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

  return {
    ok: true,
    response: {
      success: true,
      transaction: settlement.transactionHash,
      network,
      payer,
      daski: {
        paymentId: event.paymentId.toString(),
        serviceRef: challenge.serviceRef,
        serviceId: event.serviceId,
        providerTokenId: challenge.providerTokenId.toString(),
        // Use the freshly-minted ID from the event when the buyer was
        // registered atomically; otherwise echo the challenge value.
        buyerTokenId: event.buyerAgentId.toString(),
        amount: event.totalAmount.toString(),
        providerA2AUrl: challenge.providerA2AUrl,
        registered: settlement.registered,
      },
    },
  };
}
