import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  activityLimit,
  activityProjection,
} from "../src/standardRail/activityProjection.js";
import type {
  PublicChainMetadataV3,
  PublicMarketplacePurchaseV1,
  PublicOutcomeV1,
} from "../src/standardRail/types.js";

const CHAIN_FIXTURE = JSON.parse(readFileSync(
  new URL("./vectors/daski-chain-v3.json", import.meta.url),
  "utf8",
)) as PublicChainMetadataV3;

const SERVICE_A = CHAIN_FIXTURE.outcomes[0]!.serviceId;
const SERVICE_B = `0x${"34".repeat(32)}` as Hex;
let orderKeys = 0;

function purchase(outcomeId: string, timestamp: string, amount = "1000000"): PublicMarketplacePurchaseV1 {
  orderKeys += 1;
  return {
    orderKey: `0x${String(orderKeys).padStart(2, "0").repeat(32)}`,
    txHash: null,
    payer: "0x8888888888888888888888888888888888888888",
    buyerAgentId: null,
    buyerName: null,
    amount,
    outcomeId,
    timestamp,
  };
}

function outcome(overrides: {
  outcomeId: string;
  skillName: string;
  serviceId?: Hex;
  serviceName?: string;
  reputation?: Partial<PublicOutcomeV1["serviceReputation"]>;
}): PublicOutcomeV1 {
  const base = structuredClone(CHAIN_FIXTURE.outcomes[0]!);
  base.outcomeId = overrides.outcomeId;
  base.skill.name = overrides.skillName;
  if (overrides.serviceId) {
    base.serviceId = overrides.serviceId;
    base.service.id = overrides.serviceId;
  }
  if (overrides.serviceName) base.service.name = overrides.serviceName;
  base.serviceReputation = { ...base.serviceReputation, ...overrides.reputation };
  return base;
}

const CONTEXT = {
  network: "base-sepolia",
  chainId: 84532,
  contracts: CHAIN_FIXTURE.contracts,
  generatedAt: new Date("2026-09-03T16:00:00.000Z"),
};

describe("activity projection", () => {
  it("merges purchases across services newest first and names them by outcome", () => {
    // Two outcomes of service A share one reputation block, as the catalog builds them.
    const serviceA = {
      transactionCount: "3",
      totalPaid: "9000000",
      safeBlock: "100",
      recentPurchases: [
        purchase("register", "2026-09-01T00:00:00.000Z"),
        purchase("renew", "2026-09-03T00:00:00.000Z", "7000000"),
      ],
    };
    const outcomes = [
      outcome({ outcomeId: "register", skillName: "Register Domain", reputation: serviceA }),
      outcome({ outcomeId: "renew", skillName: "Renew Domain", reputation: serviceA }),
      outcome({
        outcomeId: "mailbox",
        skillName: "Create Mailbox",
        serviceId: SERVICE_B,
        serviceName: "Agent Mailboxes",
        reputation: {
          transactionCount: "1",
          totalPaid: "1250000",
          safeBlock: "250",
          recentPurchases: [purchase("mailbox", "2026-09-02T00:00:00.000Z", "1250000")],
        },
      }),
    ];

    const view = activityProjection({ ...CONTEXT, outcomes, limit: 50 });

    expect(view).toMatchObject({
      generatedAt: "2026-09-03T16:00:00.000Z",
      network: "base-sepolia",
      chainId: 84532,
      contracts: CHAIN_FIXTURE.contracts,
      safeBlock: "250",
      serviceCount: 2,
      totalPaid: "10250000",
      transactionCount: "4",
    });
    expect(view.purchases.map((row) => [row.skillName, row.serviceName, row.serviceId, row.amount])).toEqual([
      ["Renew Domain", "Domain Management", SERVICE_A, "7000000"],
      ["Create Mailbox", "Agent Mailboxes", SERVICE_B, "1250000"],
      ["Register Domain", "Domain Management", SERVICE_A, "1000000"],
    ]);
    expect(activityProjection({ ...CONTEXT, outcomes, limit: 1 }).purchases).toHaveLength(1);
  });

  it("falls back to the service outcome when a purchase names a retired outcome", () => {
    const outcomes = [outcome({
      outcomeId: "register",
      skillName: "Register Domain",
      reputation: { recentPurchases: [purchase("retired", "2026-09-01T00:00:00.000Z")] },
    })];

    const [row] = activityProjection({ ...CONTEXT, outcomes, limit: 50 }).purchases;

    expect(row).toMatchObject({
      outcomeId: "retired",
      serviceId: SERVICE_A,
      serviceName: "Domain Management",
      skillName: "Register Domain",
    });
  });

  it("reports an empty marketplace without inventing a safe block", () => {
    expect(activityProjection({ ...CONTEXT, outcomes: [], limit: 50 })).toMatchObject({
      safeBlock: null,
      serviceCount: 0,
      totalPaid: "0",
      transactionCount: "0",
      purchases: [],
    });
  });

  it("parses the limit query parameter", () => {
    expect(activityLimit(undefined)).toBe(50);
    expect(activityLimit("1")).toBe(1);
    expect(activityLimit("200")).toBe(200);
    for (const invalid of ["0", "201", "abc", "1e2", "-1", " 5", ["1"]]) {
      expect(activityLimit(invalid)).toBeNull();
    }
  });
});
