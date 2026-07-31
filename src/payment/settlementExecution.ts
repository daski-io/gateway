import type {
  PaymentChainGateway,
  PreparedSettlementTransaction,
  SettlementInput,
  SettlementResult,
} from "../chain/reader.js";
import { SettlementTransactionRevertedError } from "../chain/reader.js";
import {
  SettlementScreeningError,
} from "../chain/sanctionsErrors.js";
import type { Config } from "../config.js";
import { FacilitatorTransactionPendingError } from "../db/facilitatorLockQueries.js";
import type { Queries } from "../db/queries.js";
import type { Hex } from "../types.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import { cacheRegisteredBuyer } from "./buyerRegistrationCache.js";
import {
  FacilitatorIntentConflictError,
  FacilitatorTransactionCoordinator,
  FacilitatorTransactionTerminalError,
} from "./facilitatorTransactionCoordinator.js";
import { hashCanonical } from "./requirementResponse.js";
import {
  handleSettlementScreeningError,
  screeningFailureResult,
} from "./screeningFailure.js";
import {
  missingQuoteCommitment,
  settlementFailure,
  storedSettlementResult,
  successfulSettlementResult,
  validateSettlementEvent,
} from "./settlementResults.js";
import {
  SettlementAdmissionError,
  settlementSponsorshipError,
} from "./settlementAdmission.js";
import {
  FacilitatorBalanceError,
  requireFacilitatorBalance,
} from "./facilitatorBalance.js";
import { FacilitatorTransactionFeeError } from "../chain/facilitatorFee.js";
import { verifyPaymentPayload } from "./verifyPayload.js";
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
  if (!challenge.expectedPayee) {
    return settlementFailure(
      409,
      "expected_payee_missing",
      "stored challenge is missing its quoted settlement payee",
      config.x402Network,
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
    allowBroadcastRecovery: Boolean(
      challenge.settlementFacilitatorTransactionId,
    ),
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
  if (challenge.amount < config.settlementMinAmount) {
    return settlementFailure(
      409,
      "settlement_amount_below_minimum",
      "the quoted amount is below the gateway settlement minimum",
      config.x402Network,
      payer,
    );
  }
  const settlementInput: SettlementInput = {
    providerAgentId: challenge.providerTokenId,
    serviceId: challenge.serviceId,
    expectedPayee: challenge.expectedPayee,
    amount: challenge.amount,
    serviceRef: challenge.serviceRef,
    from: payer,
    validAfter: settleArgs.validAfter,
    validBefore: settleArgs.validBefore,
    nonce: settleArgs.nonce,
    signature: settleArgs.signature,
    nonceSalt: settleArgs.nonceSalt,
  };
  const intentHash = settlementIntentHash(settlementInput, atomic);
  const coordinator = new FacilitatorTransactionCoordinator(reader, queries);
  let settlement: SettlementResult & { registered?: boolean };
  try {
    settlement = await coordinator.execute({
      owner: {
        kind: "settlement",
        key: challenge.serviceRef.toLowerCase(),
      },
      intentHash,
      operationData: {
        serviceRef: challenge.serviceRef,
        kind: operation,
      },
      prepare: (nonce) =>
        atomic
          ? reader.prepareSettlementWithRegistration(
              {
                ...settlementInput,
                registration: atomic.registration,
              },
              nonce,
            )
          : reader.prepareSettlement(settlementInput, nonce),
      send: async (prepared, onBroadcast) => {
        await requireFacilitatorBalance(
          reader,
          config.facilitatorMinBalanceWei,
          config.facilitatorMaxTransactionFeeWei,
        );
        return reader.submitPreparedSettlement(
          { ...prepared, kind: operation } as PreparedSettlementTransaction,
          challenge.serviceRef,
          onBroadcast,
        );
      },
      inspect: (hash) =>
        reader.findSettlementByTransaction(hash, challenge.serviceRef),
      persistPrepared: async (client, transactionId, transactionHash) => {
        const sponsorshipLimit =
          await queries.reserveSettlementSponsorship(client, {
            wallet: payer,
            walletDailyLimit: config.settlementMaxPerWalletPerDay,
            globalDailyLimit: config.settlementMaxGlobalPerDay,
          });
        if (sponsorshipLimit) {
          throw settlementSponsorshipError(sponsorshipLimit);
        }
        const persisted = await queries.recordChallengeTransactionPrepared(
          client,
          challenge.serviceRef,
          transactionId,
          transactionHash,
        );
        if (!persisted) {
          throw new Error("unable to link prepared settlement transaction");
        }
      },
      persistBroadcast: async (client, transactionId, transactionHash) => {
        const persisted = await queries.recordChallengeTransactionBroadcast(
          client,
          challenge.serviceRef,
          transactionId,
          transactionHash,
        );
        if (!persisted) {
          throw new Error("unable to persist settlement broadcast");
        }
      },
      finalizeSuccess: async (client, _transactionId, result) => {
        const eventError = validateSettlementEvent(
          challenge,
          result.event,
          atomic === undefined,
        );
        if (eventError) throw new Error(eventError);
        const recorded = await queries.recordChallengePaid(
          challenge.serviceRef,
          result.event.paymentId,
          result.transactionHash,
          atomic ? result.event.buyerAgentId : undefined,
          client,
        );
        if (!recorded) throw new Error("settlement persistence conflict");
      },
      finalizeReverted: async (client, _transactionId) => {
        const current = await queries.getChallengeByRef(challenge.serviceRef);
        if (current?.transactionHash) {
          await queries.clearChallengePreparedTransaction(
            challenge.serviceRef,
            current.transactionHash,
            client,
          );
        }
      },
      isReverted: (error) =>
        error instanceof SettlementTransactionRevertedError ||
        (error instanceof SettlementScreeningError &&
          error.detectionSource === "receipt_replay"),
      failureCode: (error) =>
        error instanceof SettlementScreeningError
          ? error.failure.code
          : "settlement_transaction_reverted",
      allowNewAttemptAfterRevert: true,
    });
  } catch (error) {
    if (
      error instanceof SettlementAdmissionError ||
      error instanceof FacilitatorBalanceError
    ) {
      return settlementFailure(
        error instanceof SettlementAdmissionError ? error.status : 503,
        error.code,
        error.message,
        config.x402Network,
        payer,
      );
    }
    if (error instanceof FacilitatorTransactionFeeError) {
      return settlementFailure(
        503,
        error.code,
        error.message,
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
    if (error instanceof FacilitatorTransactionPendingError) {
      return settlementFailure(
        503,
        "facilitator_transaction_pending",
        "the facilitator wallet is reconciling a prior transaction",
        config.x402Network,
        payer,
      );
    }
    if (error instanceof FacilitatorIntentConflictError) {
      return settlementFailure(
        409,
        "operation_intent_conflict",
        "the settlement intent conflicts with the stored operation",
        config.x402Network,
        payer,
      );
    }
    if (error instanceof FacilitatorTransactionTerminalError) {
      return settlementFailure(
        503,
        "settlement_confirmation_pending",
        "the settlement transaction requires reconciliation",
        config.x402Network,
        payer,
      );
    }
    return settlementFailure(
      503,
      challenge.settlementFacilitatorTransactionId
        ? "settlement_confirmation_pending"
        : "unexpected_settle_error",
      publicErrorMessage(
        "verifyAndSettle.coordinator",
        error,
        "on-chain settlement failed",
      ),
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

function settlementIntentHash(
  input: SettlementInput,
  atomic: AtomicSettlementOptions | undefined,
): Hex {
  return hashCanonical({
    providerAgentId: input.providerAgentId.toString(),
    serviceId: input.serviceId,
    expectedPayee: input.expectedPayee,
    amount: input.amount.toString(),
    serviceRef: input.serviceRef,
    from: input.from,
    validAfter: input.validAfter.toString(),
    validBefore: input.validBefore.toString(),
    nonce: input.nonce,
    signature: input.signature,
    nonceSalt: input.nonceSalt,
    registration: atomic
      ? {
          agentURI: atomic.registration.agentURI,
          deadline: atomic.registration.deadline.toString(),
          signature: atomic.registration.signature,
        }
      : null,
  });
}
