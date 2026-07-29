import type {
  BuyerConfirmationLabel,
  ReputationRecord,
  TransactionOutcome,
} from "../../chain/reader.js";
import type { ChainActivityRow, Queries } from "../../db/queries.js";
import type { Hex, StoredChallenge } from "../../types.js";
import {
  deriveServiceWeightedSatisfaction,
  deriveSkillStats,
  type PublicSkillStats,
  type ServiceWeightedSatisfaction,
  type SkillEnrichedRow,
} from "../format.js";
import { BoundedCache } from "./bounded.js";

export interface ServiceAggregatesValue {
  fulfillment: {
    averageFulfillmentSeconds: number | null;
    sampleSize: number;
  };
  weightedSatisfaction: ServiceWeightedSatisfaction;
  skillStats: PublicSkillStats[];
}

const OUTCOMES: readonly TransactionOutcome[] = [
  "Completed",
  "Failed",
  "Canceled",
];
const CONFIRMATIONS: readonly BuyerConfirmationLabel[] = [
  "Pending",
  "Confirmed",
  "NotConfirmed",
];
const ZERO_HEX = `0x${"00".repeat(32)}` as Hex;
const ZERO_ADDRESS = `0x${"00".repeat(20)}` as Hex;

function syntheticChallenge(row: ChainActivityRow): StoredChallenge {
  return {
    serviceRef: ZERO_HEX,
    providerTokenId: row.providerAgentId,
    buyerTokenId: row.buyerAgentId,
    amount: row.amountAtomic,
    skillId: row.skillId,
    serviceSlug: row.serviceSlug ?? "",
    serviceVersion: row.serviceVersion ?? "1",
    serviceId: row.serviceId,
    providerA2AUrl: row.providerA2AUrl ?? "",
    walletAddress: row.walletAddress ?? ZERO_ADDRESS,
    createdAt: row.settledAt,
    expiresAt: row.settledAt,
    settlementState: "paid",
    paymentId: row.paymentId,
    transactionHash: row.txHash,
    preparedTransaction: null,
    preparedTransactionNonce: null,
    preparedAt: null,
    verifiedAt: row.settledAt,
    confirmationAttestationUid: row.confirmationAttestationUid,
    quoteId: null,
    quoteSignature: null,
    quoteExpiresAt: null,
    quoteRequestHash: null,
    serviceArgs: null,
    x402Version: null,
    paymentRequired: null,
    requirementsHash: null,
    resourceUrl: null,
    daskiExtension: null,
    requestFingerprint: null,
    registrationDelegation: null,
    acceptedPayer: null,
    eip3009Nonce: null,
    paymentPayloadFingerprint: null,
    settleResponse: null,
  };
}

export function chainRowToSkillEnriched(
  row: ChainActivityRow,
): SkillEnrichedRow {
  const record: ReputationRecord = {
    paymentId: row.paymentId,
    providerAgentId: row.providerAgentId,
    buyerAgentId: row.buyerAgentId,
    serviceId: row.serviceId,
    outcome:
      row.outcomeCode == null ? null : (OUTCOMES[row.outcomeCode] ?? null),
    confirmation: CONFIRMATIONS[row.confirmationCode] ?? "Pending",
    fulfillmentSeconds:
      row.fulfillmentSeconds == null ? null : BigInt(row.fulfillmentSeconds),
    outcomeTimestamp: 0n,
    confirmationTimestamp: 0n,
    outcomeRecorded: row.outcomeCode != null,
    reputationEligible: row.reputationEligible,
  };
  return {
    challenge: syntheticChallenge(row),
    record,
    refundedAtomic: row.refundedAtomic,
  };
}

const EMPTY: ServiceAggregatesValue = {
  fulfillment: { averageFulfillmentSeconds: null, sampleSize: 0 },
  weightedSatisfaction: { rateByValue: null, sampleSize: 0 },
  skillStats: [],
};

export class ServiceAggregatesCache {
  private readonly entries: BoundedCache<string, ServiceAggregatesValue>;

  constructor(
    private readonly queries: Queries,
    private readonly sampleLimit: number,
    private readonly ttlMs = 60_000,
    maxEntries = 1000,
  ) {
    this.entries = new BoundedCache(maxEntries);
  }

  async get(serviceId: Hex): Promise<ServiceAggregatesValue> {
    const key = serviceId.toLowerCase();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;

    let rows: SkillEnrichedRow[];
    try {
      rows = (
        await this.queries.listRecentChainActivityByServiceId(
          serviceId,
          this.sampleLimit,
        )
      ).map(chainRowToSkillEnriched);
    } catch {
      return hit?.value ?? EMPTY;
    }
    const fulfillment = rows
      .map((row) => row.record?.fulfillmentSeconds)
      .filter((value): value is bigint => value != null);
    const value: ServiceAggregatesValue = {
      fulfillment: {
        averageFulfillmentSeconds:
          fulfillment.length === 0
            ? null
            : Math.round(
                fulfillment.reduce((sum, value) => sum + Number(value), 0) /
                  fulfillment.length,
              ),
        sampleSize: fulfillment.length,
      },
      weightedSatisfaction: deriveServiceWeightedSatisfaction(rows),
      skillStats: deriveSkillStats(rows),
    };
    this.entries.set(key, value, now);
    return value;
  }
}
