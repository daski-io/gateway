import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    CHAIN_ID: "84532",
    CHAIN_MODE: "live",
    DATABASE_URL: "postgresql://runtime:password@localhost:5432/gateway",
    PUBLIC_URL: "http://localhost:3000",
    USDC_ADDRESS: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    USDC_DECIMALS: "6",
    USDC_NAME: "USDC",
    USDC_VERSION: "2",
    USDC_DOMAIN_SEPARATOR:
      "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818",
    SANCTIONS_ORACLE_ADDRESS: "0x1111111111111111111111111111111111111111",
    SANCTIONS_ORACLE_MODE: "mock",
    IDENTITY_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
    AGENT_INDEX_ADDRESS: "0x2222222222222222222222222222222222222222",
    PROVIDER_REGISTRY_ADDRESS: "0x3333333333333333333333333333333333333333",
    SERVICE_REGISTRY_ADDRESS: "0x4444444444444444444444444444444444444444",
    DASKI_VALIDATION_REGISTRY_ADDRESS: "0x5555555555555555555555555555555555555555",
    REPUTATION_STORAGE_ADDRESS: "0x6666666666666666666666666666666666666666",
  };
}

describe("standard-only gateway configuration", () => {
  it("loads the standard Base Sepolia runtime without a rail selector", () => {
    expect(loadConfig(environment()).x402Network).toBe("eip155:84532");
  });

  it("rejects the retired payment-rail selector", () => {
    expect(() => loadConfig({ ...environment(), PAYMENT_RAIL: "standard" }))
      .toThrow(/PAYMENT_RAIL is retired/);
  });

  it("rejects the retired mock chain runtime", () => {
    expect(() => loadConfig({ ...environment(), CHAIN_MODE: "mock" }))
      .toThrow(/only live chain evidence/);
  });
});
