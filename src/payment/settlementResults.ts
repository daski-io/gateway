import { DASKI_X402_EXTENSION_URI, type Config } from "../config.js";
import {
  SettlementTransactionRevertedError,
  type PaymentSettledEvent,
} from "../chain/reader.js";
import type { Queries } from "../db/queries.js";
import type { Hex, StoredChallenge } from "../types.js";
import type { SettlementScreeningFailure } from "../chain/sanctionsErrors.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import type { SettleResult } from "./verifyTypes.js";

export function settlementFailure(
  status: number,
  errorReason: string,
  message: string,
  network: Config["x402Network"],
  payer?: Hex,
  screeningFailure?: SettlementScreeningFailure,
): SettleResult {
  const retryable = screeningFailure?.retryable ?? status >= 500;
  return {
    ok: false,
    status,
    failure: {
      code: errorReason,
      message,
      retryable,
    },
    response: {
      success: false,
      errorReason,
      errorMessage: message,
      transaction: "",
      network,
      ...(payer ? { payer } : {}),
      retryable,
      ...(screeningFailure
        ? {
            extensions: {
              [DASKI_X402_EXTENSION_URI]: {
                screening: {
                  code: screeningFailure.code,
                  retryable: screeningFailure.retryable,
                },
              },
            },
          }
        : {}),
    },
  };
}

export function storedSettlementResult(
  challenge: StoredChallenge,
  network: Config["x402Network"],
  payer: Hex,
): SettleResult {
  if (challenge.settleResponse?.success) {
    return { ok: true, status: 200, response: challenge.settleResponse };
  }
  if (challenge.paymentId == null || !challenge.transactionHash) {
    return settlementFailure(
      500,
      "paid_challenge_incomplete",
      "paid challenge is missing its canonical settlement",
      network,
      payer,
    );
  }
  return successfulSettlementResult({
    challenge,
    event: {
      paymentId: challenge.paymentId,
      serviceRef: challenge.serviceRef,
      serviceId: challenge.serviceId,
      buyerAgentId: challenge.buyerTokenId,
      providerAgentId: challenge.providerTokenId,
      token: "0x0000000000000000000000000000000000000000",
      totalAmount: challenge.amount,
      providerAmount: challenge.amount,
      commission: 0n,
    },
    transactionHash: challenge.transactionHash,
    network,
    payer,
  });
}

export function validateSettlementEvent(
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
  if (event.serviceRef.toLowerCase() !== challenge.serviceRef.toLowerCase()) {
    return "event serviceRef does not match challenge";
  }
  if (event.serviceId.toLowerCase() !== challenge.serviceId.toLowerCase()) {
    return "event serviceId does not match challenge";
  }
  if (event.totalAmount !== challenge.amount) {
    return "event totalAmount does not match challenge amount";
  }
  if (event.providerAmount + event.commission !== event.totalAmount) {
    return "event providerAmount and commission do not equal totalAmount";
  }
  return null;
}

export async function persistSettlementEvent(
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
  return recorded;
}

export function successfulSettlementResult(args: {
  challenge: StoredChallenge;
  event: PaymentSettledEvent;
  transactionHash: Hex;
  network: Config["x402Network"];
  payer: Hex;
  registered?: boolean;
}): SettleResult {
  return {
    ok: true,
    status: 200,
    response: {
      success: true,
      transaction: args.transactionHash,
      network: args.network,
      payer: args.payer,
      amount: args.event.totalAmount.toString(),
      extensions: {
        [DASKI_X402_EXTENSION_URI]: {
          paymentId: args.event.paymentId.toString(),
          serviceRef: args.challenge.serviceRef,
          serviceId: args.event.serviceId,
          providerAgentId: args.challenge.providerTokenId.toString(),
          buyerAgentId: args.event.buyerAgentId.toString(),
          skillId: args.challenge.skillId ?? "",
          providerA2AUrl: args.challenge.providerA2AUrl,
          registered: args.registered ?? false,
          quoteId: args.challenge.quoteId ?? "",
          quoteSignature: args.challenge.quoteSignature ?? "0x",
        },
      },
    },
  };
}

export async function broadcastFailureResult(
  queries: Queries,
  challenge: StoredChallenge,
  error: unknown,
  network: Config["x402Network"],
  payer: Hex,
  context: string,
): Promise<SettleResult | null> {
  const latest = await queries.getChallengeByRef(challenge.serviceRef);
  if (!latest?.transactionHash) return null;
  if (error instanceof SettlementTransactionRevertedError) {
    await queries.clearChallengePreparedTransaction(
      challenge.serviceRef,
      latest.transactionHash,
    );
    return null;
  }
  return settlementFailure(
    503,
    "settlement_confirmation_pending",
    publicErrorMessage(
      context,
      error,
      "settlement was broadcast and is awaiting confirmation",
    ),
    network,
    payer,
  );
}

export function missingQuoteCommitment(
  challenge: StoredChallenge,
): string | null {
  const missing: string[] = [];
  if (!challenge.quoteId) missing.push("quoteId");
  if (!challenge.quoteSignature) missing.push("quoteSignature");
  if (!challenge.quoteExpiresAt) missing.push("quoteExpiresAt");
  if (!challenge.quoteRequestHash) missing.push("quoteRequestHash");
  return missing.length > 0 ? missing.join(", ") : null;
}
