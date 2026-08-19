import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { loadStandardRailConfig } from "../src/standardRail/config.js";

const protocolKey = `0x${"11".repeat(32)}`;

function standardEnv(): NodeJS.ProcessEnv {
  const manifest = JSON.stringify({
    listings: [{ commitment: { payload: { outcomeId: "stock" } } }],
  });
  return {
    MIGRATION_DATABASE_URL: "postgresql://migrator:secret@db.example.test/daski",
    PUBLIC_URL: "https://gateway.example.test",
    CDP_API_KEY_ID: "cdp-key-id",
    CDP_API_KEY_SECRET: "cdp-key-secret",
    FACILITATOR_PRIVATE_KEY: protocolKey,
    STANDARD_RAIL_ENCRYPTION_KEY: "33".repeat(32),
    BASE_RPC_URL: "https://primary-rpc.example.test",
    BASE_RPC_FALLBACK_URLS: "https://fallback-rpc.example.test",
    STANDARD_RAIL_MANIFEST_JSON: `gzip-base64:${gzipSync(manifest).toString("base64")}`,
    STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH: `0x${"66".repeat(32)}`,
    STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH: `0x${"77".repeat(32)}`,
    REPUTATION_STORAGE_ADDRESS: "0x1111111111111111111111111111111111111111",
    EAS_ADDRESS: "0x2222222222222222222222222222222222222222",
    EAS_OUTCOME_SCHEMA_UID: `0x${"44".repeat(32)}`,
    EAS_CONFIRMATION_SCHEMA_UID: `0x${"55".repeat(32)}`,
  };
}

describe("standard rail environment contract", () => {
  it("reuses the existing gateway signer, RPC, and EAS variables", () => {
    const config = loadStandardRailConfig(standardEnv());

    expect(config.quotePrivateKey).toBe(protocolKey);
    expect(config.receiptPrivateKey).toBe(protocolKey);
    expect(config.reputationRelayerPrivateKey).toBe(protocolKey);
    expect(config.evidenceRpcUrls).toEqual([
      "https://primary-rpc.example.test",
      "https://fallback-rpc.example.test",
    ]);
    expect(config.reputationOutcomeSchemaUid).toBe(`0x${"44".repeat(32)}`);
    expect(config.reputationConfirmationSchemaUid).toBe(`0x${"55".repeat(32)}`);
    expect(config.reputationConfirmationGasLimit).toBe(750_000n);
    expect(config.splitterFactoryRuntimeCodeHash).toBe(`0x${"66".repeat(32)}`);
    expect(config.splitterCreationCodeHash).toBe(`0x${"77".repeat(32)}`);
  });

  it("rejects an uncompressed manifest value", () => {
    const env = standardEnv();
    env.STANDARD_RAIL_MANIFEST_JSON = JSON.stringify({ listings: [] });
    expect(() => loadStandardRailConfig(env)).toThrow(/MANIFEST_JSON is malformed/);
  });

  it.each([
    "STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH",
    "STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH",
  ])("rejects a missing %s trust anchor", (name) => {
    const env = standardEnv();
    delete env[name];
    expect(() => loadStandardRailConfig(env)).toThrow(`${name} is required`);
  });

  it.each([
    "STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH",
    "STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH",
  ])("rejects a malformed %s trust anchor", (name) => {
    const env = standardEnv();
    env[name] = "0x1234";
    expect(() => loadStandardRailConfig(env)).toThrow(/non-zero bytes32/);
  });

  it.each([
    "STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH",
    "STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH",
  ])("rejects an all-zero %s trust anchor", (name) => {
    const env = standardEnv();
    env[name] = `0x${"00".repeat(32)}`;
    expect(() => loadStandardRailConfig(env)).toThrow(/non-zero bytes32/);
  });
});
