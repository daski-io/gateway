import type {
  PaymentChainGateway,
  PreparedSettlementTransaction,
  SettlementResult,
} from "../chain/reader.js";
import { SettlementTransactionRevertedError } from "../chain/reader.js";
import { SettlementScreeningError } from "../chain/sanctionsErrors.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import {
  FacilitatorTransactionCoordinator,
} from "./facilitatorTransactionCoordinator.js";
import { validateSettlementEvent } from "./settlementResults.js";
import { recordScreeningFailure } from "./screeningFailure.js";
import { requireFacilitatorBalance } from "./settlementAdmission.js";

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
  const due = await queries.listDueFacilitatorTransactions("settlement", limit);
  let recovered = 0;
  for (const transaction of due) {
    const serviceRef =
      typeof transaction.operationData.serviceRef === "string"
        ? (transaction.operationData.serviceRef as `0x${string}`)
        : (transaction.operationKey as `0x${string}`);
    const challenge = await queries.getChallengeByRef(serviceRef);
    if (
      !challenge ||
      challenge.settlementFacilitatorTransactionId !== transaction.id
    ) continue;
    const kind =
      transaction.operationData.kind === "settle_with_registration"
        ? "settle_with_registration"
        : "settle";
    const coordinator = new FacilitatorTransactionCoordinator(reader, queries);
    try {
      await coordinator.execute<SettlementResult & { registered?: boolean }>({
        owner: {
          kind: "settlement",
          key: challenge.serviceRef.toLowerCase(),
        },
        intentHash: transaction.intentHash,
        operationData: transaction.operationData,
        prepare: async () => {
          throw new Error("recovery cannot prepare a replacement transaction");
        },
        send: async (prepared, onBroadcast) => {
          await requireFacilitatorBalance(
            reader,
            config.facilitatorMinBalanceWei,
          );
          return reader.submitPreparedSettlement(
            {
              ...prepared,
              kind,
            } as PreparedSettlementTransaction,
            challenge.serviceRef,
            onBroadcast,
          );
        },
        inspect: (hash) =>
          reader.findSettlementByTransaction(hash, challenge.serviceRef),
        persistPrepared: async () => {
          throw new Error("recovery cannot replace the business link");
        },
        persistBroadcast: async (client, id, hash) => {
          const recorded = await queries.recordChallengeTransactionBroadcast(
            client,
            challenge.serviceRef,
            id,
            hash,
          );
          if (!recorded) throw new Error("settlement broadcast state conflict");
        },
        finalizeSuccess: async (client, _id, result) => {
          const invalid = validateSettlementEvent(
            challenge,
            result.event,
            challenge.buyerTokenId !== 0n,
          );
          if (invalid) throw new Error(invalid);
          const recorded = await queries.recordChallengePaid(
            challenge.serviceRef,
            result.event.paymentId,
            result.transactionHash,
            challenge.buyerTokenId === 0n
              ? result.event.buyerAgentId
              : undefined,
            client,
          );
          if (!recorded) throw new Error("settlement recovery state conflict");
        },
        finalizeReverted: async (client) => {
          await queries.clearChallengePreparedTransaction(
            challenge.serviceRef,
            transaction.transactionHash,
            client,
          );
        },
        isReverted: (error) =>
          error instanceof SettlementTransactionRevertedError ||
          (error instanceof SettlementScreeningError &&
            error.detectionSource === "receipt_replay"),
        failureCode: (error) =>
          error instanceof SettlementScreeningError
            ? error.failure.code
            : "settlement_transaction_reverted",
        allowNewAttemptAfterRevert: false,
      });
      recovered += 1;
    } catch (error) {
      if (error instanceof SettlementScreeningError) {
        await recordScreeningFailure({
          queries,
          config,
          challenge,
          failure: error.failure,
          detectionSource: error.detectionSource,
          operation: kind,
          transactionHash: error.transactionHash,
        }).catch(() => undefined);
      }
      // The journal retains the exact transaction for the next bounded pass.
    }
  }
  return { scanned: due.length, recovered };
}
