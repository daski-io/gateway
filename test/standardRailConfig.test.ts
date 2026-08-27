import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { keccak256 } from "viem";
import { loadStandardRailConfig } from "../src/standardRail/config.js";

const protocolKey = `0x${"11".repeat(32)}`;
const creationCode = `0x${"6001600101".repeat(4)}` as const;
const creationCodeHash = keccak256(creationCode);

function standardEnv(): NodeJS.ProcessEnv {
  const manifest = JSON.stringify({
    providerControlProfiles: [],
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
    STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH: creationCodeHash,
    STANDARD_RAIL_SPLITTER_CREATION_CODE:
      `gzip-base64:${gzipSync(creationCode).toString("base64")}`,
    STANDARD_RAIL_SPLITTER_RUNTIME_CODE_HASH: `0x${"88".repeat(32)}`,
    STANDARD_RAIL_SPLITTER_FACTORY: "0x9999999999999999999999999999999999999999",
    STANDARD_RAIL_COMMISSION_RECEIVER: "0x8888888888888888888888888888888888888888",
    STANDARD_RAIL_COMMISSION_BPS: "250",
    STANDARD_RAIL_SANCTIONS_ORACLE: "0x7777777777777777777777777777777777777777",
    STANDARD_RAIL_SANCTIONS_ORACLE_RUNTIME_CODE_HASH: `0x${"99".repeat(32)}`,
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
    expect(config.splitterCreationCodeHash).toBe(creationCodeHash);
  });

  it("loads the first-class dynamic listing deployment policy", () => {
    const config = loadStandardRailConfig(standardEnv());

    expect(config.dynamicListingPolicy).toEqual({
      splitterFactory: "0x9999999999999999999999999999999999999999",
      daskiCommissionReceiver: "0x8888888888888888888888888888888888888888",
      commissionBps: 250,
      splitterCreationCode: creationCode,
      splitterRuntimeCodeHash: `0x${"88".repeat(32)}`,
    });
    expect(config.screeningPolicy).toEqual({
      sanctionsOracle: "0x7777777777777777777777777777777777777777",
      sanctionsOracleRuntimeCodeHash: `0x${"99".repeat(32)}`,
    });
  });

  it("rejects an uncompressed manifest value", () => {
    const env = standardEnv();
    env.STANDARD_RAIL_MANIFEST_JSON = JSON.stringify({ providerControlProfiles: [] });
    expect(() => loadStandardRailConfig(env)).toThrow(/MANIFEST_JSON is malformed/);
  });

  it("rejects splitter creation code that does not match its pinned hash", () => {
    const env = standardEnv();
    env.STANDARD_RAIL_SPLITTER_CREATION_CODE =
      `gzip-base64:${gzipSync("0x60016002" as string).toString("base64")}`;
    expect(() => loadStandardRailConfig(env))
      .toThrow(/does not match its pinned hash/);
  });

  it("rejects a commission that cannot fund both payment legs", () => {
    const env = standardEnv();
    env.STANDARD_RAIL_COMMISSION_BPS = "10000";
    expect(() => loadStandardRailConfig(env)).toThrow(/below 10000/);
  });

  it.each([
    "STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH",
    "STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH",
    "STANDARD_RAIL_SPLITTER_RUNTIME_CODE_HASH",
    "STANDARD_RAIL_SANCTIONS_ORACLE_RUNTIME_CODE_HASH",
  ])("rejects a missing %s trust anchor", (name) => {
    const env = standardEnv();
    delete env[name];
    expect(() => loadStandardRailConfig(env)).toThrow(`${name} is required`);
  });

  it.each([
    "STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH",
    "STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH",
    "STANDARD_RAIL_SPLITTER_RUNTIME_CODE_HASH",
    "STANDARD_RAIL_SANCTIONS_ORACLE_RUNTIME_CODE_HASH",
  ])("rejects a malformed %s trust anchor", (name) => {
    const env = standardEnv();
    env[name] = "0x1234";
    expect(() => loadStandardRailConfig(env)).toThrow(/non-zero bytes32/);
  });

  it.each([
    "STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH",
    "STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH",
    "STANDARD_RAIL_SPLITTER_RUNTIME_CODE_HASH",
    "STANDARD_RAIL_SANCTIONS_ORACLE_RUNTIME_CODE_HASH",
  ])("rejects an all-zero %s trust anchor", (name) => {
    const env = standardEnv();
    env[name] = `0x${"00".repeat(32)}`;
    expect(() => loadStandardRailConfig(env)).toThrow(/non-zero bytes32/);
  });

  it.each([
    "STANDARD_RAIL_SPLITTER_FACTORY",
    "STANDARD_RAIL_COMMISSION_RECEIVER",
    "STANDARD_RAIL_SANCTIONS_ORACLE",
  ])("rejects an all-zero %s address", (name) => {
    const env = standardEnv();
    env[name] = `0x${"00".repeat(20)}`;
    expect(() => loadStandardRailConfig(env)).toThrow(/non-zero EVM address/);
  });
});
