import { SettlementScreeningError } from "../chain/sanctionsErrors.js";
import type { PaymentChainGateway } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import { logger } from "../util/logger.js";
import { handleSettlementScreeningError } from "./screeningFailure.js";
import {
  persistSettlementEvent,
  validateSettlementEvent,
} from "./settlementResults.js";

export interface SettlementReconciliationResult {
  scanned: number;
  recovered: number;
}

export async function reconcileBroadcastSettlements(
  reader: PaymentChainGateway,
  queries: Queries,
  config: Config,
  limit = 100,
): Promise<SettlementReconciliationResult> {
  const challenges = await queries.listBroadcastChallenges(limit);
  let recovered = 0;
  await Promise.all(
    challenges.map(async (challenge) => {
      if (!challenge.transactionHash) return;
      const atomic = challenge.buyerTokenId === 0n;
      try {
        const settlement = await reader.getSettlementByTransaction(
          challenge.transactionHash,
          challenge.serviceRef,
        );
        const validationError = validateSettlementEvent(
          challenge,
          settlement.event,
          !atomic,
        );
        if (validationError) {
          logger.warn("settlement.reconciliation_event_mismatch", {
            serviceRef: challenge.serviceRef,
            transactionHash: challenge.transactionHash,
          });
          return;
        }
        if (
          await persistSettlementEvent(
            queries,
            challenge,
            settlement.event,
            settlement.transactionHash,
            atomic ? settlement.event.buyerAgentId : undefined,
          )
        ) {
          recovered += 1;
        }
      } catch (error) {
        if (error instanceof SettlementScreeningError) {
          await handleSettlementScreeningError(
            error,
            challenge,
            config,
            queries,
            challenge.walletAddress,
            atomic ? "settle_with_registration" : "settle",
          );
        }
      }
    }),
  );
  return { scanned: challenges.length, recovered };
}
