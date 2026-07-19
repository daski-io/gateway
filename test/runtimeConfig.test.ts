import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/runtimeConfig.js";

describe("loadRuntimeConfig", () => {
  it("forbids mock chain mode in production", () => {
    expect(() =>
      loadRuntimeConfig({
        NODE_ENV: "Production",
        CHAIN_MODE: "mock",
      }),
    ).toThrow(/forbidden/);
  });

  it("validates aggregate security budgets", () => {
    expect(() =>
      loadRuntimeConfig({
        REGISTRATION_SPONSOR_MAX_PER_HOUR: "-1",
      }),
    ).toThrow(/REGISTRATION_SPONSOR_MAX_PER_HOUR/);
  });

  it("allows standalone registration sponsorship to be disabled", () => {
    expect(
      loadRuntimeConfig({
        REGISTRATION_SPONSOR_MAX_PER_HOUR: "0",
      }).registrationSponsorMaxPerHour,
    ).toBe(0);
  });
});
