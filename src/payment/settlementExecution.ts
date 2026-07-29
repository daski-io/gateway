import type { PaymentChainGateway, SettlementInput } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import { SettlementOutboxPendingError } from "../db/facilitatorLockQueries.js";
import type { Hex } from "../types.js";
import { SettlementScreeningError } from "../chain/sanctionsErrors.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import { cacheRegisteredBuyer } from "./buyerRegistrationCache.js";
import {
  broadcastFailureResult,
  missingQuoteCommitment,
  persistSettlementEvent,
  settlementFailure,
  storedSettlementResult,
  successfulSettlementResult,
  validateSettlementEvent,
} from "./settlementResults.js";
import { verifyPaymentPayload } from "./verifyPayload.js";
import { recoverPendingSettlement } from "./settlementRecovery.js";
import {
  handleSettlementScreeningError,
  screeningFailureResult,
} from "./screeningFailure.js";
import type {
  AtomicSettlementOptions,
  SettleInput,
  SettleResult,
} from "./verifyTypes.js";

export async function verifyAndSettleUnlocked(
  input: SettleInput,
  config: Config,
  reader: PaymentChainGateway,
  queries: Queries,
  now: Date = new Date(),
  atomic?: AtomicSettlementOptions,
): Promise<SettleResult> {
  const { challenge } = input;
  const operation = atomic
    ? ("settle_with_registration" as const)
    : ("settle" as const);
  if (challenge.settlementState === "sanctions_rejected") {
    const stored = await queries.getTerminalSettlementScreeningFailure(
      challenge.serviceRef,
    );
    return stored
      ? screeningFailureResult(stored, config, challenge.walletAddress)
      : settlementFailure(
          500,
          "screening_evidence_missing",
          "terminal settlement screening evidence is missing",
          config.x402Network,
          challenge.walletAddress,
        );
  }
  const missingQuote = missingQuoteCommitment(challenge);
  if (missingQuote) {
    return settlementFailure(
      409,
      "quote_commitment_missing",
      `stored challenge is missing provider quote commitment fields: ${missingQuote}`,
      config.x402Network,
    );
  }
  const verified = await verifyPaymentPayload(input, config, reader, now, {
    allowBroadcastRecovery: Boolean(challenge.transactionHash),
    queries,
  });
  if (!verified.ok) {
    return settlementFailure(
      verified.status,
      verified.errorReason,
      verified.message,
      config.x402Network,
      verified.payer,
    );
  }
  const { payer, settleArgs } = verified;
  if (verified.alreadyPaid) {
    return storedSettlementResult(challenge, config.x402Network, payer);
  }
  const enforceBuyer = atomic === undefined;
  const settlementInput: SettlementInput = {
    providerAgentId: challenge.providerTokenId,
    serviceId: challenge.serviceId,
    amount: challenge.amount,
    serviceRef: challenge.serviceRef,
    from: payer,
    validAfter: settleArgs.validAfter,
    validBefore: settleArgs.validBefore,
    nonce: settleArgs.nonce,
    signature: settleArgs.signature,
    nonceSalt: settleArgs.nonceSalt,
  };
  if (challenge.transactionHash) {
    return recoverPendingSettlement(
      challenge,
      config,
      reader,
      queries,
      payer,
      enforceBuyer,
      Boolean(atomic),
    );
  }
  let settlement: Awaited<
    ReturnType<PaymentChainGateway["submitPreparedSettlement"]>
  > & {
    registered?: boolean;
  };
  try {
    settlement = await queries.withFacilitatorTransactionLock(
      async (release) => {
        const prepared = atomic
          ? await reader.prepareSettlementWithRegistration({
              ...settlementInput,
              registration: atomic.registration,
            })
          : await reader.prepareSettlement(settlementInput);
        const persisted = await queries.recordChallengeTransactionPrepared(
          challenge.serviceRef,
          prepared.transactionHash,
          prepared.serializedTransaction,
          prepared.facilitatorNonce,
        );
        if (!persisted) {
          throw new Error("unable to persist prepared settlement transaction");
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
    );
  } catch (error) {
    if (error instanceof SettlementOutboxPendingError) {
      return settlementFailure(
        503,
        "settlement_outbox_pending",
        "another settlement is awaiting transaction reconciliation",
        config.x402Network,
        payer,
      );
    }
    if (error instanceof SettlementScreeningError) {
      return handleSettlementScreeningError(
        error,
        challenge,
        config,
        queries,
        payer,
        operation,
      );
    }
    const context = atomic
      ? "verifyAndSettle.submitPreparedWithRegistration"
      : "verifyAndSettle.submitPrepared";
    const pending = await broadcastFailureResult(
      queries,
      challenge,
      error,
      config.x402Network,
      payer,
      context,
    );
    if (pending) return pending;
    return settlementFailure(
      402,
      "unexpected_settle_error",
      publicErrorMessage(
        context,
        error,
        atomic
          ? "on-chain atomic register-and-settle failed"
          : "on-chain settlement failed",
      ),
      config.x402Network,
      payer,
    );
  }
  const eventError = validateSettlementEvent(
    challenge,
    settlement.event,
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
    settlement.event,
    settlement.transactionHash,
    atomic ? settlement.event.buyerAgentId : undefined,
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
  if (atomic && settlement.registered) {
    await cacheRegisteredBuyer(
      atomic.registration,
      atomic.options,
      config,
      queries,
      settlement.event.buyerAgentId,
      payer,
    );
  }
  const result = successfulSettlementResult({
    challenge,
    event: settlement.event,
    transactionHash: settlement.transactionHash,
    network: config.x402Network,
    payer,
    ...(atomic ? { registered: settlement.registered ?? true } : {}),
  });
  await queries.recordSettleResponse(challenge.serviceRef, result.response);
  return result;
}
