import type {
  PaymentChainGateway,
  PreparedSettlementTransaction,
  SettlementResult,
} from "../chain/reader.js";
import { SettlementTransactionRevertedError } from "../chain/reader.js";
import { SettlementScreeningError } from "../chain/sanctionsErrors.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { Hex, StoredChallenge } from "../types.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import { logger } from "../util/logger.js";
import { handleSettlementScreeningError } from "./screeningFailure.js";
import {
  persistSettlementEvent,
  settlementFailure,
  successfulSettlementResult,
  validateSettlementEvent,
} from "./settlementResults.js";
import type { SettleResult } from "./verifyTypes.js";

export async function recoverPendingSettlement(
  challenge: StoredChallenge,
  config: Config,
  reader: PaymentChainGateway,
  queries: Queries,
  payer: Hex,
  enforceBuyer: boolean,
  atomic: boolean,
): Promise<SettleResult> {
  let recovered: SettlementResult & { registered?: boolean };
  try {
    recovered = await queries.withFacilitatorTransactionLock(
      async (release) => {
        const existing = await reader.findSettlementByTransaction(
          challenge.transactionHash!,
          challenge.serviceRef,
        );
        if (existing) {
          await release();
          return existing;
        }
        const prepared = preparedFromChallenge(challenge);
        if (!prepared) {
          throw new Error(
            "pending settlement is missing its signed transaction",
          );
        }
        const nextNonce = await reader.getFacilitatorTransactionCount();
        if (nextNonce > prepared.facilitatorNonce) {
          await queries.recordPreparedSettlementNonceConflict(
            challenge.serviceRef,
          );
          throw new Error(
            "prepared settlement nonce was consumed; receipt reconciliation is required",
          );
        }
        const onBroadcast = async (transactionHash: Hex) => {
          const recorded = await queries.recordChallengeTransactionBroadcast(
            challenge.serviceRef,
            transactionHash,
          );
          if (!recorded) {
            throw new Error(
              "unable to persist broadcast settlement transaction",
            );
          }
          await release();
        };
        return reader.submitPreparedSettlement(
          prepared,
          challenge.serviceRef,
          onBroadcast,
        );
      },
      {
        owner: {
          kind: "settlement",
          serviceRef: challenge.serviceRef,
        },
      },
    );
  } catch (error) {
    if (error instanceof SettlementScreeningError) {
      return handleSettlementScreeningError(
        error,
        challenge,
        config,
        queries,
        payer,
        atomic ? "settle_with_registration" : "settle",
      );
    }
    if (error instanceof SettlementTransactionRevertedError) {
      const cleared = await queries.clearChallengePreparedTransaction(
        challenge.serviceRef,
        challenge.transactionHash!,
      );
      if (!cleared) {
        return settlementFailure(
          503,
          "settlement_confirmation_pending",
          "reverted settlement could not be reconciled",
          config.x402Network,
          payer,
        );
      }
      return settlementFailure(
        402,
        "unexpected_settle_error",
        "on-chain settlement reverted",
        config.x402Network,
        payer,
      );
    }
    return settlementFailure(
      503,
      "settlement_confirmation_pending",
      publicErrorMessage(
        atomic
          ? "verifyAndSettleWithRegistration.recoverPending"
          : "verifyAndSettle.recoverPending",
        error,
        "settlement is prepared or broadcast and is awaiting confirmation",
      ),
      config.x402Network,
      payer,
    );
  }
  const eventError = validateSettlementEvent(
    challenge,
    recovered.event,
    enforceBuyer,
  );
  if (eventError) {
    return settlementFailure(
      500,
      "unexpected_settle_error",
      eventError,
      config.x402Network,
      payer,
    );
  }
  const recorded = await persistSettlementEvent(
    queries,
    challenge,
    recovered.event,
    recovered.transactionHash,
    atomic ? recovered.event.buyerAgentId : undefined,
  );
  if (!recorded) {
    return settlementFailure(
      500,
      "settlement_persistence_conflict",
      "on-chain settlement conflicts with the stored challenge",
      config.x402Network,
      payer,
    );
  }
  const result = successfulSettlementResult({
    challenge,
    event: recovered.event,
    transactionHash: recovered.transactionHash,
    network: config.x402Network,
    payer,
    ...(atomic ? { registered: true } : {}),
  });
  await queries.recordSettleResponse(challenge.serviceRef, result.response);
  logger.info("x402.broadcast_recovery", {
    source: "paid_request",
    atomic,
  });
  return result;
}

export function preparedFromChallenge(
  challenge: StoredChallenge,
): PreparedSettlementTransaction | null {
  if (
    !challenge.transactionHash ||
    !challenge.preparedTransaction ||
    challenge.preparedTransactionNonce == null
  ) {
    return null;
  }
  return {
    transactionHash: challenge.transactionHash,
    serializedTransaction: challenge.preparedTransaction,
    facilitatorNonce: challenge.preparedTransactionNonce,
    kind: challenge.buyerTokenId === 0n ? "settle_with_registration" : "settle",
  };
}
