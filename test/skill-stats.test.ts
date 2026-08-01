import { describe, expect, it } from "vitest";
import {
  SATISFACTION_FLOOR_USDC_ATOMIC,
  deriveServiceWeightedSatisfaction,
  deriveSkillStats,
  satisfactionWeight,
  type SkillEnrichedRow,
} from "../src/public/format.js";
import type {
  BuyerConfirmationLabel,
  ReputationRecord,
  TransactionOutcome,
} from "../src/chain/reader.js";
import type { Hex, StoredChallenge } from "../src/types.js";

// ── Test fixture helpers ───────────────────────────────────────────────

const ZERO_BYTES = ("0x" + "00".repeat(32)) as Hex;

function makeChallenge(opts: {
  skillId: string | null;
  amountAtomic: bigint;
  buyerTokenId?: bigint;
  paymentId?: bigint | null;
}): StoredChallenge {
  return {
    serviceRef: ZERO_BYTES,
    providerTokenId: 1n,
    buyerTokenId: opts.buyerTokenId ?? 10n,
    amount: opts.amountAtomic,
    skillId: opts.skillId,
    serviceSlug: "test-service",
    serviceVersion: "1",
    serviceId: ZERO_BYTES,
    providerA2AUrl: "http://provider.test/a2a",
    walletAddress: "0x0000000000000000000000000000000000000001" as Hex,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    settlementState: "paid",
    paymentId: opts.paymentId === undefined ? 1n : opts.paymentId,
    transactionHash: ZERO_BYTES,
    verifiedAt: new Date(),
    confirmationAttestationUid: null,
    createdAt: new Date(),
    quoteId: null,
    quoteSignature: null,
    quoteExpiresAt: null,
    quoteRequestHash: null,
    x402Version: 2,
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
    expectedPayee: null,
    expectedPayeeBlock: null,
    settlementFacilitatorTransactionId: null,
    providerAuthorityWallet: null,
    providerAuthorityAgentUri: null,
    providerAuthorityBlock: null,
  };
}

function makeRecord(opts: {
  outcome?: TransactionOutcome;
  confirmation?: BuyerConfirmationLabel;
  fulfillmentSeconds?: bigint | null;
  outcomeRecorded?: boolean;
}): ReputationRecord {
  return {
    paymentId: 1n,
    providerAgentId: 1n,
    buyerAgentId: 10n,
    serviceId: ZERO_BYTES,
    outcome: opts.outcome ?? "Completed",
    confirmation: opts.confirmation ?? "Pending",
    fulfillmentSeconds:
      opts.fulfillmentSeconds === undefined ? 60n : opts.fulfillmentSeconds,
    outcomeTimestamp: 0n,
    confirmationTimestamp: 0n,
    outcomeRecorded: opts.outcomeRecorded ?? true,
    reputationEligible: true,
    currentConfirmationUid: ZERO_BYTES,
  };
}

function row(opts: {
  skillId: string | null;
  amountAtomic: bigint;
  buyerTokenId?: bigint;
  outcome?: TransactionOutcome;
  confirmation?: BuyerConfirmationLabel;
  fulfillmentSeconds?: bigint | null;
  outcomeRecorded?: boolean;
  refundedAtomic?: bigint;
  noRecord?: boolean;
}): SkillEnrichedRow {
  return {
    challenge: makeChallenge({
      skillId: opts.skillId,
      amountAtomic: opts.amountAtomic,
      buyerTokenId: opts.buyerTokenId,
    }),
    record: opts.noRecord
      ? null
      : makeRecord({
          outcome: opts.outcome,
          confirmation: opts.confirmation,
          fulfillmentSeconds: opts.fulfillmentSeconds,
          outcomeRecorded: opts.outcomeRecorded,
        }),
    refundedAtomic: opts.refundedAtomic ?? 0n,
  };
}

// ── satisfactionWeight: floor + log2 curve ─────────────────────────────

describe("satisfactionWeight", () => {
  it("returns 0 for amounts strictly below the floor", () => {
    expect(satisfactionWeight(0n)).toBe(0);
    expect(satisfactionWeight(1n)).toBe(0);
    expect(satisfactionWeight(100n)).toBe(0); // $0.0001
    expect(satisfactionWeight(SATISFACTION_FLOOR_USDC_ATOMIC - 1n)).toBe(0);
  });

  it("returns 1.0 exactly at the floor", () => {
    // $0.25 = floor → log2(1 + 1) = log2(2) = 1
    expect(satisfactionWeight(SATISFACTION_FLOOR_USDC_ATOMIC)).toBeCloseTo(
      1.0,
      10,
    );
  });

  it("follows the log2 curve above the floor", () => {
    // $1.00 = 4× floor → log2(1 + 4) = log2(5) ≈ 2.3219
    expect(satisfactionWeight(1_000_000n)).toBeCloseTo(Math.log2(5), 10);
    // $10 = 40× floor → log2(41) ≈ 5.358
    expect(satisfactionWeight(10_000_000n)).toBeCloseTo(Math.log2(41), 10);
    // $100 = 400× floor → log2(401) ≈ 8.648
    expect(satisfactionWeight(100_000_000n)).toBeCloseTo(Math.log2(401), 10);
  });

  it("kills the $0.0001 self-attestation Sybil attack", () => {
    // Whitepaper-stated invariant: 1000 attestations at $0.0001 each
    // contribute zero total weight, so a sybil ring can't move the
    // weighted satisfaction rate at all.
    let total = 0;
    for (let i = 0; i < 1000; i++) total += satisfactionWeight(100n);
    expect(total).toBe(0);
  });
});

// ── deriveServiceWeightedSatisfaction: pooled across all skills ────────

describe("deriveServiceWeightedSatisfaction", () => {
  it("returns null when no attestations land above the floor", () => {
    const rows = [
      row({ skillId: "a", amountAtomic: 100n, confirmation: "Confirmed" }), // below floor
      row({ skillId: "b", amountAtomic: 0n, confirmation: "NotConfirmed" }), // below floor
      row({ skillId: "c", amountAtomic: 1_000_000n, confirmation: "Pending" }), // not attested
    ];
    const result = deriveServiceWeightedSatisfaction(rows);
    expect(result.rateByValue).toBeNull();
    expect(result.sampleSize).toBe(0);
  });

  it("weights single attestation correctly", () => {
    const rows = [
      row({ skillId: "a", amountAtomic: 1_000_000n, confirmation: "Confirmed" }),
    ];
    const result = deriveServiceWeightedSatisfaction(rows);
    expect(result.rateByValue).toBe(1.0);
    expect(result.sampleSize).toBe(1);
  });

  it("dampens a single whale's negative attestation via log curve", () => {
    // 1 NotConfirmed at $1000 + 4 Confirmed at $1 each.
    //
    //   Linear weighting would give whale weight 1000, others weight 4
    //   → rate = 4/1004 ≈ 0.4% (whale dominates)
    //
    //   Our log2 weighting:
    //   whale weight = log2(1 + 1000/0.25) = log2(4001) ≈ 11.97
    //   each small  = log2(1 + 1/0.25) = log2(5) ≈ 2.322
    //   confirmed total = 4 × 2.322 ≈ 9.288
    //   denom = 9.288 + 11.97 ≈ 21.26
    //   rate ≈ 9.288 / 21.26 ≈ 0.437 — still hurts, but recoverable.
    const rows = [
      row({
        skillId: "a",
        amountAtomic: 1_000_000_000n,
        confirmation: "NotConfirmed",
      }),
      ...Array.from({ length: 4 }, () =>
        row({ skillId: "a", amountAtomic: 1_000_000n, confirmation: "Confirmed" }),
      ),
    ];
    const result = deriveServiceWeightedSatisfaction(rows);
    expect(result.rateByValue).toBeCloseTo(
      (4 * Math.log2(5)) / (4 * Math.log2(5) + Math.log2(4001)),
      10,
    );
    expect(result.sampleSize).toBe(5);
  });

  it("ignores pending attestations and below-floor attestations", () => {
    const rows = [
      row({ skillId: "a", amountAtomic: 100n, confirmation: "Confirmed" }), // below floor → excluded
      row({ skillId: "a", amountAtomic: 1_000_000n, confirmation: "Pending" }), // pending → excluded
      row({ skillId: "a", amountAtomic: 1_000_000n, confirmation: "Confirmed" }), // counts
      row({
        skillId: "a",
        amountAtomic: 1_000_000n,
        confirmation: "NotConfirmed",
      }), // counts
    ];
    const result = deriveServiceWeightedSatisfaction(rows);
    // 1 confirmed × log2(5), 1 notConfirmed × log2(5) → rate = 0.5
    expect(result.rateByValue).toBeCloseTo(0.5, 10);
    expect(result.sampleSize).toBe(2);
  });
});

// ── deriveSkillStats: per-skill grouping + aggregates ──────────────────

describe("deriveSkillStats", () => {
  it("groups by skillId and skips rows with null skillId", () => {
    const rows = [
      row({ skillId: "register-domain", amountAtomic: 5_000_000n }),
      row({ skillId: "register-domain", amountAtomic: 5_000_000n }),
      row({ skillId: "transfer-out", amountAtomic: 15_000_000n }),
      row({ skillId: null, amountAtomic: 1_000_000n }), // dropped
    ];
    const stats = deriveSkillStats(rows);
    expect(stats).toHaveLength(2);
    const byId = new Map(stats.map((s) => [s.skillId, s]));
    expect(byId.get("register-domain")?.totalTransactions).toBe(2);
    expect(byId.get("transfer-out")?.totalTransactions).toBe(1);
  });

  it("sums totalSpentUsdc per skill", () => {
    const rows = [
      row({ skillId: "register-domain", amountAtomic: 4_990_000n }),
      row({ skillId: "register-domain", amountAtomic: 4_990_000n }),
      row({ skillId: "transfer-out", amountAtomic: 25_000_000n }),
    ];
    const stats = deriveSkillStats(rows);
    const reg = stats.find((s) => s.skillId === "register-domain")!;
    const xfer = stats.find((s) => s.skillId === "transfer-out")!;
    expect(reg.totalSpentUsdc).toBe("9.98");
    expect(xfer.totalSpentUsdc).toBe("25.00");
  });

  it("counts unique buyers per skill (Sybil concentration signal)", () => {
    const rows = [
      row({
        skillId: "register-domain",
        amountAtomic: 5_000_000n,
        buyerTokenId: 1n,
      }),
      row({
        skillId: "register-domain",
        amountAtomic: 5_000_000n,
        buyerTokenId: 1n, // same buyer again
      }),
      row({
        skillId: "register-domain",
        amountAtomic: 5_000_000n,
        buyerTokenId: 2n,
      }),
    ];
    const stats = deriveSkillStats(rows);
    expect(stats[0].totalTransactions).toBe(3);
    expect(stats[0].uniqueBuyerCount).toBe(2);
  });

  it("computes median + P90 fulfillment time across the skill's samples", () => {
    // Times: 10, 20, 30, 40, 50 — sorted → P50 = 30, P90 = 46.
    const rows = [10n, 20n, 30n, 40n, 50n].map((s) =>
      row({
        skillId: "register-domain",
        amountAtomic: 5_000_000n,
        fulfillmentSeconds: s,
      }),
    );
    const stats = deriveSkillStats(rows);
    expect(stats[0].medianFulfillmentSeconds).toBe(30);
    expect(stats[0].p90FulfillmentSeconds).toBe(46);
    expect(stats[0].fulfillmentSampleSize).toBe(5);
  });

  it("computes count-based and value-weighted satisfaction side-by-side", () => {
    // 3 Confirmed at $1, 1 NotConfirmed at $100.
    // Count-based: 3/4 = 0.75
    // Value-weighted: 3·log2(5) / (3·log2(5) + log2(401)) ≈ 6.965 / 15.61 ≈ 0.446
    const rows = [
      row({ skillId: "a", amountAtomic: 1_000_000n, confirmation: "Confirmed" }),
      row({ skillId: "a", amountAtomic: 1_000_000n, confirmation: "Confirmed" }),
      row({ skillId: "a", amountAtomic: 1_000_000n, confirmation: "Confirmed" }),
      row({
        skillId: "a",
        amountAtomic: 100_000_000n,
        confirmation: "NotConfirmed",
      }),
    ];
    const stats = deriveSkillStats(rows);
    expect(stats[0].buyerSatisfactionRate).toBeCloseTo(0.75, 10);
    expect(stats[0].buyerSatisfactionRateByValue).toBeCloseTo(
      (3 * Math.log2(5)) / (3 * Math.log2(5) + Math.log2(401)),
      10,
    );
  });

  it("tracks refund total and refund rate", () => {
    const rows = [
      row({
        skillId: "a",
        amountAtomic: 10_000_000n,
        outcome: "Completed",
        refundedAtomic: 5_000_000n,
      }),
      row({
        skillId: "a",
        amountAtomic: 10_000_000n,
        outcome: "Completed",
        refundedAtomic: 0n,
      }),
      row({
        skillId: "a",
        amountAtomic: 10_000_000n,
        outcome: "Completed",
        refundedAtomic: 0n,
      }),
    ];
    const stats = deriveSkillStats(rows);
    expect(stats[0].refundCount).toBe(1);
    expect(stats[0].refundedUsdc).toBe("5.00");
    expect(stats[0].refundRate).toBeCloseTo(1 / 3, 10);
  });

  it("handles rows without an on-chain record (pending settlement)", () => {
    const rows = [
      row({ skillId: "a", amountAtomic: 5_000_000n, noRecord: true }),
      row({ skillId: "a", amountAtomic: 5_000_000n, confirmation: "Confirmed" }),
    ];
    const stats = deriveSkillStats(rows);
    expect(stats[0].totalTransactions).toBe(2);
    expect(stats[0].completedCount).toBe(1); // only the one with outcome
    expect(stats[0].pendingConfirmationCount).toBe(1); // null record + Pending = 1
    expect(stats[0].buyerSatisfactionRate).toBe(1.0);
  });

  it("sorts output by transaction count descending, skillId ascending as tiebreak", () => {
    const rows = [
      row({ skillId: "b-skill", amountAtomic: 5_000_000n }),
      row({ skillId: "a-skill", amountAtomic: 5_000_000n }),
      row({ skillId: "a-skill", amountAtomic: 5_000_000n }),
      row({ skillId: "c-skill", amountAtomic: 5_000_000n }),
      row({ skillId: "c-skill", amountAtomic: 5_000_000n }),
    ];
    const stats = deriveSkillStats(rows);
    // a-skill: 2, b-skill: 1, c-skill: 2 → sorted: a-skill, c-skill (alpha tiebreak), b-skill.
    expect(stats.map((s) => s.skillId)).toEqual([
      "a-skill",
      "c-skill",
      "b-skill",
    ]);
  });

  it("populates skillName from the provided lookup map", () => {
    const rows = [
      row({ skillId: "register-domain", amountAtomic: 5_000_000n }),
      row({ skillId: "transfer-out", amountAtomic: 25_000_000n }),
    ];
    const names = new Map([
      ["register-domain", "Register Domain"],
      // transfer-out intentionally missing — should fall back to null.
    ]);
    const stats = deriveSkillStats(rows, names);
    const reg = stats.find((s) => s.skillId === "register-domain")!;
    const xfer = stats.find((s) => s.skillId === "transfer-out")!;
    expect(reg.skillName).toBe("Register Domain");
    expect(xfer.skillName).toBeNull();
  });
});
