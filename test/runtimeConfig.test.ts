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

  it("requires an explicit proxy trust boundary in production", () => {
    expect(() =>
      loadRuntimeConfig({
        NODE_ENV: "production",
        CHAIN_MODE: "live",
      }),
    ).toThrow(/TRUST_PROXY must be set explicitly/);

    expect(
      loadRuntimeConfig({
        NODE_ENV: "production",
        CHAIN_MODE: "live",
        TRUST_PROXY: "1",
      }).trustProxy,
    ).toBe(1);
  });

  it("validates aggregate security budgets", () => {
    expect(() =>
      loadRuntimeConfig({
        STATE_CHANGE_GLOBAL_MAX_PER_MINUTE: "-1",
      }),
    ).toThrow(/STATE_CHANGE_GLOBAL_MAX_PER_MINUTE/);
  });

  it("loads tunable MCP session limits and rejects an invalid split", () => {
    const config = loadRuntimeConfig({
      MCP_MAX_SESSIONS: "250",
      MCP_MAX_SESSIONS_PER_CLIENT: "25",
      MCP_SESSION_IDLE_TTL_MS: "120000",
      MCP_SESSION_SWEEP_INTERVAL_MS: "30000",
    });
    expect(config).toMatchObject({
      mcpMaxSessions: 250,
      mcpMaxSessionsPerClient: 25,
      mcpSessionIdleTtlMs: 120_000,
      mcpSessionSweepIntervalMs: 30_000,
    });
    expect(() =>
      loadRuntimeConfig({
        MCP_MAX_SESSIONS: "10",
        MCP_MAX_SESSIONS_PER_CLIENT: "11",
      }),
    ).toThrow(/MCP_MAX_SESSIONS_PER_CLIENT/);
  });

  it("has no standalone registration sponsorship setting", () => {
    const config = loadRuntimeConfig({
      REGISTRATION_SPONSOR_MAX_PER_HOUR: "20",
    });
    expect("registrationSponsorMaxPerHour" in config).toBe(false);
  });
});
