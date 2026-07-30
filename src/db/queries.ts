import type { Pool } from "./pool.js";
import { createAggregateQueries } from "./aggregateQueries.js";
import { createBuyerIdentityQueries } from "./buyerIdentityQueries.js";
import { createChainEventQueries } from "./chainEventQueries.js";
import { createChallengeSettlementLock } from "./challengeSettlementLock.js";
import { createConfirmationSubmissionQueries } from "./confirmationSubmissionQueries.js";
import { createFacilitatorLockQueries } from "./facilitatorLockQueries.js";
import { createFacilitatorTransactionQueries } from "./facilitatorTransactionQueries.js";
import { createPaymentChallengeQueries } from "./paymentChallengeQueries.js";
import { createPaymentChallengeStateQueries } from "./paymentChallengeStateQueries.js";
import { createRateLimitQueries } from "./rateLimitQueries.js";
import { createReputationQueries } from "./reputationQueries.js";
import { createReputationStateQueries } from "./reputationStateQueries.js";
import { createReputationTransactionQueries } from "./reputationTransactionQueries.js";
import { createSkillQueries } from "./skillQueries.js";
import { createSettlementScreeningQueries } from "./settlementScreeningQueries.js";
import { createTaskMappingQueries } from "./taskMappingQueries.js";
import { createTransactionQueries } from "./transactionQueries.js";

export type { ChainActivityRow } from "./chainEventQueries.js";
export type { ReputationMirrorRow } from "./reputationRows.js";
export type { SkillSearchHit } from "./skillQueries.js";

export function createQueries(pool: Pool) {
  return {
    ...createFacilitatorLockQueries(pool),
    ...createFacilitatorTransactionQueries(pool),
    ...createConfirmationSubmissionQueries(pool),
    ...createTransactionQueries(pool),
    ...createRateLimitQueries(pool),
    ...createPaymentChallengeQueries(pool),
    ...createPaymentChallengeStateQueries(pool),
    ...createChallengeSettlementLock(pool),
    ...createReputationQueries(pool),
    ...createReputationStateQueries(pool),
    ...createReputationTransactionQueries(pool),
    ...createSkillQueries(pool),
    ...createBuyerIdentityQueries(pool),
    ...createAggregateQueries(pool),
    ...createChainEventQueries(pool),
    ...createSettlementScreeningQueries(pool),
    ...createTaskMappingQueries(pool),
  };
}

export type Queries = ReturnType<typeof createQueries>;
