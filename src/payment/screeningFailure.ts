import type {
  ScreeningDetectionSource,
  SettlementScreeningFailure,
} from "../chain/sanctionsErrors.js";
import { SettlementScreeningError } from "../chain/sanctionsErrors.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { SettlementOperation } from "../db/settlementScreeningQueries.js";
import type { Hex, StoredChallenge } from "../types.js";
import { logger } from "../util/logger.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import { settlementFailure } from "./settlementResults.js";
import type { SettleResult } from "./verifyTypes.js";

export function screeningFailureResult(
  failure: SettlementScreeningFailure,
  config: Config,
  payer: Hex,
): SettleResult {
  const rejected = failure.code === "SANCTIONS_ADDRESS_REJECTED";
  return settlementFailure(
    rejected ? 402 : 503,
    failure.code,
    rejected
      ? "This payment cannot be processed."
      : "Payment cannot be processed right now. Please try again later.",
    config.x402Network,
    payer,
    failure,
  );
}

export async function recordScreeningFailure(input: {
  queries: Queries;
  config: Config;
  challenge: StoredChallenge;
  failure: SettlementScreeningFailure;
  detectionSource: ScreeningDetectionSource;
  operation: SettlementOperation;
  transactionHash?: Hex | null;
}): Promise<void> {
  const recorded = await input.queries.recordSettlementScreeningEvent({
    challenge: input.challenge,
    failure: input.failure,
    detectionSource: input.detectionSource,
    operation: input.operation,
    chainId: input.config.chainId,
    paymentRouter: input.config.paymentRouterAddress,
    adapterAddress: input.config.x402AdapterAddress,
    transactionHash: input.transactionHash,
  });
  logger.info(
    input.failure.code === "SANCTIONS_ADDRESS_REJECTED"
      ? "payment.sanctions_address_rejected"
      : "payment.sanctions_screening_unavailable",
    {
      eventId: recorded.eventId,
      code: input.failure.code,
      chainId: input.config.chainId,
      operation: input.operation,
      detectionSource: input.detectionSource,
      serviceRef: input.challenge.serviceRef,
      transactionHash: input.transactionHash ?? null,
      occurrenceCount: recorded.occurrenceCount,
    },
  );
}

export async function handleSettlementScreeningError(
  error: SettlementScreeningError,
  challenge: StoredChallenge,
  config: Config,
  queries: Queries,
  payer: Hex,
  operation: SettlementOperation,
): Promise<SettleResult> {
  try {
    await recordScreeningFailure({
      queries,
      config,
      challenge,
      failure: error.failure,
      detectionSource: error.detectionSource,
      operation,
      transactionHash: error.transactionHash,
    });
    if (
      error.failure.code === "SANCTIONS_SCREENING_UNAVAILABLE" &&
      error.transactionHash
    ) {
      const cleared = await queries.clearChallengeTransactionBroadcast(
        challenge.serviceRef,
        error.transactionHash,
      );
      if (!cleared) {
        throw new Error("unable to clear reverted settlement broadcast");
      }
    }
  } catch (persistenceError) {
    return settlementFailure(
      503,
      error.transactionHash
        ? "settlement_confirmation_pending"
        : "screening_evidence_unavailable",
      publicErrorMessage(
        "verifyAndSettle.screeningEvidence",
        persistenceError,
        error.transactionHash
          ? "settlement reverted and is awaiting reconciliation"
          : "payment screening could not be recorded",
      ),
      config.x402Network,
      payer,
    );
  }
  return screeningFailureResult(error.failure, config, payer);
}
