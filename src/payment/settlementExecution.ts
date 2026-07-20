import type { PaymentChainGateway } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { Hex } from "../types.js";
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
  const missingQuote = missingQuoteCommitment(challenge);
  if (missingQuote) {
    return settlementFailure(
      409,
      "quote_commitment_missing",
      `stored challenge is missing provider quote commitment fields: ${missingQuote}`,
      config.network,
    );
  }
  const verified = await verifyPaymentPayload(input, config, reader, now, {
    allowBroadcastRecovery: Boolean(challenge.transactionHash),
  });
  if (!verified.ok) {
    return settlementFailure(
      verified.status,
      verified.errorReason,
      verified.message,
      config.network,
      verified.payer,
    );
  }
  const { payer, settleArgs } = verified;
  if (verified.alreadyPaid) {
    return storedSettlementResult(challenge, config.network, payer);
  }
  const enforceBuyer = atomic === undefined;
  if (challenge.transactionHash) {
    return recoverBroadcast(
      input,
      config,
      reader,
      queries,
      payer,
      enforceBuyer,
      Boolean(atomic),
    );
  }
  let settlement: Awaited<ReturnType<PaymentChainGateway["settlePayment"]>> & {
    registered?: boolean;
  };
  try {
    settlement = await queries.withFacilitatorTransactionLock((release) => {
      const settlementInput = {
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
      };
      const onBroadcast = async (transactionHash: Hex) => {
        const recorded = await queries.recordChallengeTransactionBroadcast(
          challenge.serviceRef,
          transactionHash,
        );
        if (!recorded) {
          throw new Error("unable to persist broadcast settlement transaction");
        }
        await release();
      };
      return atomic
        ? reader.settleWithRegistration(
            { ...settlementInput, registration: atomic.registration },
            onBroadcast,
          )
        : reader.settlePayment(settlementInput, onBroadcast);
    });
  } catch (error) {
    const context = atomic
      ? "verifyAndSettle.settleWithRegistration"
      : "verifyAndSettle.settlePayment";
    const pending = await broadcastFailureResult(
      queries,
      challenge,
      error,
      config.network,
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
      config.network,
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
      config.network,
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
      config.network,
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
  return successfulSettlementResult({
    challenge,
    event: settlement.event,
    transactionHash: settlement.transactionHash,
    network: config.network,
    payer,
    ...(atomic ? { registered: settlement.registered ?? true } : {}),
  });
}

async function recoverBroadcast(
  input: SettleInput,
  config: Config,
  reader: PaymentChainGateway,
  queries: Queries,
  payer: Hex,
  enforceBuyer: boolean,
  atomic: boolean,
): Promise<SettleResult> {
  const challenge = input.challenge;
  let recovered: Awaited<ReturnType<PaymentChainGateway["getSettlementByTransaction"]>>;
  try {
    recovered = await reader.getSettlementByTransaction(
      challenge.transactionHash!,
      challenge.serviceRef,
    );
  } catch (error) {
    return settlementFailure(
      503,
      "settlement_confirmation_pending",
      publicErrorMessage(
        atomic
          ? "verifyAndSettleWithRegistration.recoverBroadcast"
          : "verifyAndSettle.recoverBroadcast",
        error,
        "settlement was broadcast and is awaiting confirmation",
      ),
      config.network,
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
      config.network,
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
      config.network,
      payer,
    );
  }
  return successfulSettlementResult({
    challenge,
    event: recovered.event,
    transactionHash: recovered.transactionHash,
    network: config.network,
    payer,
    ...(atomic ? { registered: true } : {}),
  });
}
