import { describe, expect, it } from "vitest";
import { assertListingRoleSeparation } from "../src/standardRail/listingRoles.js";

const provider = "0x1111111111111111111111111111111111111111";
const payee = "0x2222222222222222222222222222222222222222";
const commission = "0x3333333333333333333333333333333333333333";

describe("standard-rail listing roles", () => {
  it("allows the provider authority to receive the provider payout", () => {
    expect(() => assertListingRoleSeparation(provider, provider, commission)).not.toThrow();
  });

  it("keeps the Daski commission receiver outside provider-controlled roles", () => {
    expect(() => assertListingRoleSeparation(provider, payee, provider))
      .toThrow(/commission receiver must be distinct/);
    expect(() => assertListingRoleSeparation(provider, payee, payee))
      .toThrow(/commission receiver must be distinct/);
  });
});
