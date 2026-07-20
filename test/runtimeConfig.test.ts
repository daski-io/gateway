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
        STATE_CHANGE_GLOBAL_MAX_PER_MINUTE: "-1",
      }),
    ).toThrow(/STATE_CHANGE_GLOBAL_MAX_PER_MINUTE/);
  });

  it("has no standalone registration sponsorship setting", () => {
    const config = loadRuntimeConfig({
      REGISTRATION_SPONSOR_MAX_PER_HOUR: "20",
    });
    expect("registrationSponsorMaxPerHour" in config).toBe(false);
  });
});
