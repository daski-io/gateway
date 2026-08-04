import type { Hex } from "./types.js";
import { isHexAddress } from "./util/evmValidation.js";

export type ChainMode = "live" | "mock";

export interface RuntimeConfig {
  nodeEnv: string;
  chainMode: ChainMode;
  trustProxy: number;
  challengeRetentionSeconds: number;
  taskMappingPendingRetentionSeconds: number;
  taskRetentionSeconds: number;
  rpcReadMaxPerMinute: number;
  stateChangeGlobalMaxPerMinute: number;
  mcpGlobalMaxPerMinute: number;
  mcpMaxSessions: number;
  mcpMaxSessionsPerClient: number;
  mcpSessionIdleTtlMs: number;
  mcpSessionSweepIntervalMs: number;
  publicReadMaxPerMinute: number;
  publicReadGlobalMaxPerMinute: number;
  publicCacheMaxEntries: number;
  discoveryMaxA2AEntries: number;
  discoveryFetchConcurrency: number;
  discoveryRefreshDeadlineMs: number;
  shutdownGraceMs: number;
  mockProviderWalletAddress: Hex;
  mockProviderAgentId: bigint;
  mockProviderAgentUri: string;
  mockBuyerAgentId: bigint;
}

function integer(
  name: string,
  raw: string | undefined,
  fallback: number,
  options: { allowZero?: boolean } = {},
): number {
  const value = Number(raw ?? fallback);
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function bigintValue(name: string, raw: string | undefined, fallback: string): bigint {
  try {
    const value = BigInt(raw ?? fallback);
    if (value <= 0n) throw new Error("non-positive");
    return value;
  } catch {
    throw new Error(`${name} must be a positive integer`);
  }
}

function mockWallet(raw: string | undefined): Hex {
  const value = raw ?? `0x${"11".repeat(20)}`;
  if (!isHexAddress(value)) {
    throw new Error("MOCK_PROVIDER_WALLET_ADDRESS must be a 20-byte address");
  }
  return value.toLowerCase() as Hex;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const nodeEnv = (env.NODE_ENV ?? "development").trim().toLowerCase();
  const chainMode = env.CHAIN_MODE ?? "live";
  if (chainMode !== "live" && chainMode !== "mock") {
    throw new Error("CHAIN_MODE must be either live or mock");
  }
  if (nodeEnv === "production" && chainMode === "mock") {
    throw new Error("CHAIN_MODE=mock is forbidden when NODE_ENV=production");
  }
  if (nodeEnv === "production" && env.TRUST_PROXY === undefined) {
    throw new Error("TRUST_PROXY must be set explicitly in production");
  }
  const mcpMaxSessions = integer(
    "MCP_MAX_SESSIONS",
    env.MCP_MAX_SESSIONS,
    100,
  );
  const mcpMaxSessionsPerClient = integer(
    "MCP_MAX_SESSIONS_PER_CLIENT",
    env.MCP_MAX_SESSIONS_PER_CLIENT,
    10,
  );
  if (mcpMaxSessionsPerClient > mcpMaxSessions) {
    throw new Error(
      "MCP_MAX_SESSIONS_PER_CLIENT cannot exceed MCP_MAX_SESSIONS",
    );
  }

  return {
    nodeEnv,
    chainMode,
    trustProxy: integer("TRUST_PROXY", env.TRUST_PROXY, 0, {
      allowZero: true,
    }),
    challengeRetentionSeconds: integer(
      "CHALLENGE_RETENTION_SECONDS",
      env.CHALLENGE_RETENTION_SECONDS,
      7 * 24 * 60 * 60,
    ),
    taskMappingPendingRetentionSeconds: integer(
      "TASK_MAPPING_PENDING_RETENTION_SECONDS",
      env.TASK_MAPPING_PENDING_RETENTION_SECONDS,
      24 * 60 * 60,
    ),
    taskRetentionSeconds: integer(
      "TASK_RETENTION_SECONDS",
      env.TASK_RETENTION_SECONDS,
      365 * 24 * 60 * 60,
    ),
    rpcReadMaxPerMinute: integer("RPC_READ_MAX_PER_MINUTE", env.RPC_READ_MAX_PER_MINUTE, 300),
    stateChangeGlobalMaxPerMinute: integer(
      "STATE_CHANGE_GLOBAL_MAX_PER_MINUTE",
      env.STATE_CHANGE_GLOBAL_MAX_PER_MINUTE,
      300,
    ),
    mcpGlobalMaxPerMinute: integer(
      "MCP_GLOBAL_MAX_PER_MINUTE",
      env.MCP_GLOBAL_MAX_PER_MINUTE,
      300,
    ),
    mcpMaxSessions,
    mcpMaxSessionsPerClient,
    mcpSessionIdleTtlMs: integer(
      "MCP_SESSION_IDLE_TTL_MS",
      env.MCP_SESSION_IDLE_TTL_MS,
      10 * 60 * 1000,
    ),
    mcpSessionSweepIntervalMs: integer(
      "MCP_SESSION_SWEEP_INTERVAL_MS",
      env.MCP_SESSION_SWEEP_INTERVAL_MS,
      60 * 1000,
    ),
    publicReadMaxPerMinute: integer(
      "PUBLIC_READ_MAX_PER_MINUTE",
      env.PUBLIC_READ_MAX_PER_MINUTE,
      120,
    ),
    publicReadGlobalMaxPerMinute: integer(
      "PUBLIC_READ_GLOBAL_MAX_PER_MINUTE",
      env.PUBLIC_READ_GLOBAL_MAX_PER_MINUTE,
      1200,
    ),
    publicCacheMaxEntries: integer(
      "PUBLIC_CACHE_MAX_ENTRIES",
      env.PUBLIC_CACHE_MAX_ENTRIES,
      1000,
    ),
    discoveryMaxA2AEntries: integer("DISCOVERY_MAX_A2A_ENTRIES", env.DISCOVERY_MAX_A2A_ENTRIES, 16),
    discoveryFetchConcurrency: integer(
      "DISCOVERY_FETCH_CONCURRENCY",
      env.DISCOVERY_FETCH_CONCURRENCY,
      4,
    ),
    discoveryRefreshDeadlineMs: integer(
      "DISCOVERY_REFRESH_DEADLINE_MS",
      env.DISCOVERY_REFRESH_DEADLINE_MS,
      30_000,
    ),
    shutdownGraceMs: integer(
      "SHUTDOWN_GRACE_MS",
      env.SHUTDOWN_GRACE_MS,
      25_000,
    ),
    mockProviderWalletAddress: mockWallet(env.MOCK_PROVIDER_WALLET_ADDRESS),
    mockProviderAgentId: bigintValue("MOCK_PROVIDER_AGENT_ID", env.MOCK_PROVIDER_AGENT_ID, "1"),
    mockProviderAgentUri:
      env.MOCK_PROVIDER_AGENT_URI ?? "http://localhost:4040/.well-known/agent.json",
    mockBuyerAgentId: bigintValue("MOCK_BUYER_AGENT_ID", env.MOCK_BUYER_AGENT_ID, "99"),
  };
}
