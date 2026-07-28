import type { PaymentChainGateway } from "../chain/reader.js";
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

export async function recoverBroadcastSettlement(
  challenge: StoredChallenge,
  config: Config,
  reader: PaymentChainGateway,
  queries: Queries,
  payer: Hex,
  enforceBuyer: boolean,
  atomic: boolean,
): Promise<SettleResult> {
  let recovered: Awaited<
    ReturnType<PaymentChainGateway["getSettlementByTransaction"]>
  >;
  try {
    recovered = await reader.getSettlementByTransaction(
      challenge.transactionHash!,
      challenge.serviceRef,
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
