import { describe, expect, it } from "vitest";
import {
  validateRefundRiskPolicies,
} from "../src/bazaar/refundPolicy.js";
import type { BazaarRefundRiskPolicy } from "../src/bazaar/types.js";
import { createBazaarHarness } from "./helpers/bazaar.js";

describe("Bazaar refund-risk policy", () => {
  it("requires one valid monotonic policy for every listed provider", async () => {
    const harness = await createBazaarHarness();
    expect(() => validateRefundRiskPolicies({}, harness.wiring.listings))
      .toThrow(/do not match listed providers/);

    const policy = harness.wiring.refundRiskPolicies["701"]!;
    const nonMonotonic: BazaarRefundRiskPolicy = {
      ...policy,
      maxAggregateReserved: policy.maxAggregatePaidUnfulfilled + 1n,
    };
    expect(() => validateRefundRiskPolicies(
      { "701": nonMonotonic },
      harness.wiring.listings,
    )).toThrow(/policy is invalid/);

    expect(() => validateRefundRiskPolicies(
      { ...harness.wiring.refundRiskPolicies, "702": policy },
      harness.wiring.listings,
    )).toThrow(/do not match listed providers/);
  });
});
