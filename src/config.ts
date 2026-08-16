import type { Network } from "@x402/core/types";
import {
  loadUsdcDomain,
  REVIEWED_USDC_DOMAINS,
  type UsdcDomainConfig,
} from "./payment/usdcDomain.js";
import type { ChainId, Hex } from "./types.js";
import { isHexAddress } from "./util/evmValidation.js";

export const BASE_MAINNET_SANCTIONS_ORACLE =
  "0x3a91a31cb3dc49b4db9ce721f50a9d076c8d739b" as Hex;

export type SanctionsOracleMode = "production" | "mock";

export interface Config {
  nodeEnv: string;
  port: number;
  trustProxy: number;
  mcpEnabled: boolean;
  mcpPath: string;
  chainId: ChainId;
  network: "base" | "base-sepolia";
  x402Network: Network;
  databaseUrl: string;
  publicUrl: string;
  usdc: UsdcDomainConfig;
  sanctionsOracleAddress: Hex;
  sanctionsOracleMode: SanctionsOracleMode;
  marketplaceContracts: {
    identityRegistry: Hex;
    agentIndex: Hex;
    providerRegistry: Hex;
    serviceRegistry: Hex;
    validationRegistry: Hex;
    reputationStorage: Hex;
  };
  rpcReadMaxPerMinute: number;
  stateChangeGlobalMaxPerMinute: number;
  mcpGlobalMaxPerMinute: number;
  publicReadMaxPerMinute: number;
  publicReadGlobalMaxPerMinute: number;
  shutdownGraceMs: number;
}

function integer(
  name: string,
  raw: string | undefined,
  fallback: number,
  options: { allowZero?: boolean; maximum?: number } = {},
): number {
  const value = Number(raw ?? fallback);
  const minimum = options.allowZero ? 0 : 1;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function booleanValue(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be either 'true' or 'false'`);
}

function chainId(raw: string | undefined): ChainId {
  const value = Number(raw ?? 84532);
  if (value !== 8453 && value !== 84532) throw new Error(`Unsupported chainId: ${value}`);
  return value;
}

function address(name: string, raw: string | undefined): Hex {
  if (!raw || !isHexAddress(raw)) throw new Error(`${name} must be a 20-byte hex address`);
  return raw.toLowerCase() as Hex;
}

function databaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error("DATABASE_URL is required");
  const parsed = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname || !parsed.username || parsed.pathname === "/"
  ) {
    throw new Error("DATABASE_URL must identify a PostgreSQL database and role");
  }
  return raw;
}

function httpUrl(name: string, raw: string | undefined, requireHttps: boolean): string {
  if (!raw) throw new Error(`${name} is required`);
  const parsed = new URL(raw);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username || parsed.password ||
    (requireHttps && parsed.protocol !== "https:")
  ) {
    throw new Error(`${name} must be a credential-free ${requireHttps ? "HTTPS" : "HTTP(S)"} URL`);
  }
  return raw.replace(/\/$/, "");
}

function mcpPath(raw: string | undefined): string {
  const value = raw ?? "/mcp";
  if (
    !/^\/[A-Za-z0-9/_-]*$/.test(value) || value.includes("//") ||
    (value.length > 1 && value.endsWith("/"))
  ) throw new Error("MCP_PATH must be a normalized absolute URL path");
  return value;
}

function sanctionsMode(raw: string | undefined): SanctionsOracleMode {
  if (raw === undefined) return "production";
  if (raw === "production" || raw === "mock") return raw;
  throw new Error("SANCTIONS_ORACLE_MODE must be explicitly set to production or mock");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.PAYMENT_RAIL !== undefined) {
    throw new Error("PAYMENT_RAIL is retired; the gateway always uses standard Exact-EVM");
  }
  if (env.CHAIN_MODE !== undefined && env.CHAIN_MODE !== "live") {
    throw new Error("The standard gateway supports only live chain evidence");
  }
  const nodeEnv = (env.NODE_ENV ?? "development").trim().toLowerCase();
  const production = nodeEnv === "production";
  if (production && env.TRUST_PROXY === undefined) {
    throw new Error("TRUST_PROXY must be set explicitly in production");
  }
  const configuredChainId = chainId(env.CHAIN_ID);
  const oracleAddress = address("SANCTIONS_ORACLE_ADDRESS", env.SANCTIONS_ORACLE_ADDRESS);
  const oracleMode = sanctionsMode(env.SANCTIONS_ORACLE_MODE);
  if (configuredChainId === 8453 && oracleAddress !== BASE_MAINNET_SANCTIONS_ORACLE) {
    throw new Error(`Base mainnet SANCTIONS_ORACLE_ADDRESS must be ${BASE_MAINNET_SANCTIONS_ORACLE}`);
  }
  if (configuredChainId === 8453 && (oracleMode !== "production" || !production)) {
    throw new Error("Base mainnet requires production sanctions screening and NODE_ENV=production");
  }
  if (production && oracleMode === "mock") {
    throw new Error("SANCTIONS_ORACLE_MODE=mock is forbidden in production");
  }
  const tokenAddress = address(
    "USDC_ADDRESS",
    env.USDC_ADDRESS ?? REVIEWED_USDC_DOMAINS[configuredChainId].address,
  );
  return {
    nodeEnv,
    port: integer("PORT", env.PORT, 3000, { maximum: 65535 }),
    trustProxy: integer("TRUST_PROXY", env.TRUST_PROXY, 0, { allowZero: true }),
    mcpEnabled: booleanValue("MCP_ENABLED", env.MCP_ENABLED, true),
    mcpPath: mcpPath(env.MCP_PATH),
    chainId: configuredChainId,
    network: configuredChainId === 8453 ? "base" : "base-sepolia",
    x402Network: `eip155:${configuredChainId}`,
    databaseUrl: databaseUrl(env.DATABASE_URL),
    publicUrl: httpUrl("PUBLIC_URL", env.PUBLIC_URL, production),
    usdc: loadUsdcDomain({ chainId: configuredChainId, address: tokenAddress, env }),
    sanctionsOracleAddress: oracleAddress,
    sanctionsOracleMode: oracleMode,
    marketplaceContracts: {
      identityRegistry: address("IDENTITY_REGISTRY_ADDRESS", env.IDENTITY_REGISTRY_ADDRESS),
      agentIndex: address("AGENT_INDEX_ADDRESS", env.AGENT_INDEX_ADDRESS),
      providerRegistry: address("PROVIDER_REGISTRY_ADDRESS", env.PROVIDER_REGISTRY_ADDRESS),
      serviceRegistry: address("SERVICE_REGISTRY_ADDRESS", env.SERVICE_REGISTRY_ADDRESS),
      validationRegistry: address(
        "DASKI_VALIDATION_REGISTRY_ADDRESS",
        env.DASKI_VALIDATION_REGISTRY_ADDRESS,
      ),
      reputationStorage: address(
        "REPUTATION_STORAGE_ADDRESS",
        env.REPUTATION_STORAGE_ADDRESS,
      ),
    },
    rpcReadMaxPerMinute: integer("RPC_READ_MAX_PER_MINUTE", env.RPC_READ_MAX_PER_MINUTE, 300),
    stateChangeGlobalMaxPerMinute: integer(
      "STATE_CHANGE_GLOBAL_MAX_PER_MINUTE",
      env.STATE_CHANGE_GLOBAL_MAX_PER_MINUTE,
      300,
    ),
    mcpGlobalMaxPerMinute: integer("MCP_GLOBAL_MAX_PER_MINUTE", env.MCP_GLOBAL_MAX_PER_MINUTE, 300),
    publicReadMaxPerMinute: integer("PUBLIC_READ_MAX_PER_MINUTE", env.PUBLIC_READ_MAX_PER_MINUTE, 120),
    publicReadGlobalMaxPerMinute: integer(
      "PUBLIC_READ_GLOBAL_MAX_PER_MINUTE",
      env.PUBLIC_READ_GLOBAL_MAX_PER_MINUTE,
      1200,
    ),
    shutdownGraceMs: integer("SHUTDOWN_GRACE_MS", env.SHUTDOWN_GRACE_MS, 25_000),
  };
}
