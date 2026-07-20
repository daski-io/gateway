import {
  SettlementTransactionRevertedError,
  type ChainReader,
} from "../chain/reader.js";
import type { Queries } from "../db/queries.js";
import { logErrorWithId } from "../util/errorWrap.js";
import {
  persistSettlementEvent,
  validateSettlementEvent,
} from "./verify.js";

export interface ExternalReconciliationResult {
  scanned: number;
  recovered: number;
}

export async function reconcileExternalSettlements(
  reader: ChainReader,
  queries: Queries,
  limit = 20,
): Promise<ExternalReconciliationResult> {
  const challenges = await queries.listUnresolvedExternalChallenges(limit);
  let recovered = 0;

  for (const candidate of challenges) {
    try {
      const didRecover = await queries.withChallengeSettlementLock(
        candidate.serviceRef,
        async () => {
          const challenge = await queries.getChallengeByRef(
            candidate.serviceRef,
          );
          if (
            !challenge ||
            challenge.status === "paid" ||
            challenge.externalSettleTx ||
            !challenge.authNonce
          ) {
            return false;
          }
          const consumed = await reader.authorizationUsed(
            challenge.walletAddress,
            challenge.authNonce,
          );
          if (!consumed) return false;

          let settlement;
          try {
            settlement = challenge.transactionHash
              ? await reader.getSettlementByTransaction(
                  challenge.transactionHash,
                  challenge.serviceRef,
                )
              : await queries.withFacilitatorTransactionLock((release) =>
                  reader.attributeDirectTransfer(
                    {
                      providerAgentId: challenge.providerTokenId,
                      serviceId: challenge.serviceId,
                      amount: challenge.amount,
                      serviceRef: challenge.serviceRef,
                      from: challenge.walletAddress,
                      authNonce: challenge.authNonce!,
                    },
                    async (transactionHash) => {
                      const recorded =
                        await queries.recordChallengeTransactionBroadcast(
                          challenge.serviceRef,
                          transactionHash,
                        );
                      if (!recorded) {
                        throw new Error(
                          "unable to persist reconciled attribution broadcast",
                        );
                      }
                      await release();
                    },
                  ),
                );
          } catch (error) {
            if (
              error instanceof SettlementTransactionRevertedError &&
              challenge.transactionHash
            ) {
              await queries.clearChallengeTransactionBroadcast(
                challenge.serviceRef,
                challenge.transactionHash,
              );
              return false;
            }
            throw error;
          }
          const eventError = validateSettlementEvent(
            challenge,
            settlement.event,
            true,
          );
          if (eventError) throw new Error(eventError);
          return persistSettlementEvent(
            queries,
            challenge,
            settlement.event,
            settlement.transactionHash,
            settlement.event.buyerAgentId,
          );
        },
      );
      if (didRecover) recovered += 1;
    } catch (error) {
      logErrorWithId("externalSettlementReconciler.challenge", error);
    }
  }
  return { scanned: challenges.length, recovered };
}
