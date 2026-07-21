import type { ChainId, Hex } from "./types.js";
import { requireMarketplaceHttpsUrl } from "./legal/validation.js";
import { isHex32, isHexAddress } from "./util/evmValidation.js";
import {
  loadRuntimeConfig,
  type RuntimeConfig,
} from "./runtimeConfig.js";

export const DASKI_A2A_EXTENSION_URI = "https://daski.xyz/a2a/v1";

export const X402_VERSION = 1;

export const BASE_MAINNET_SANCTIONS_ORACLE =
  "0x3a91a31cb3dc49b4db9ce721f50a9d076c8d739b" as Hex;

export type SanctionsOracleMode = "production" | "mock";

export interface Config extends RuntimeConfig {
  port: number;
  // Hosted MCP transport at this path (default /mcp). The MCP is the
  // wallet-agnostic tool surface; signing happens in the agent's wallet,
  // not here. Set MCP_ENABLED=false to run the gateway as REST-only.
  mcpEnabled: boolean;
  mcpPath: string;
  baseRpcUrl: string;
  chainId: ChainId;
  network: "base" | "base-sepolia";
  // CANONICAL per-chain ERC-8004 IdentityRegistry (0x8004A… singleton) —
  // Daski no longer deploys an identity registry of its own.
  identityRegistryAddress: Hex;
  // Daski AgentIndex proxy — verified wallet→agentId reverse lookup plus
  // delegated registerWithSig; the companion that fills the canonical
  // registry's gaps. Also the EIP-712 verifyingContract for the
  // RegisterAgent typed-data buyers sign.
  agentIndexAddress: Hex;
  providerRegistryAddress: Hex;
  // ServiceRegistry — service-identity refactor (2026-05). serviceId is
  // computed off-chain from (providerAgentId, serviceSlug, version) and the
  // gateway threads it through the EIP-3009 nonce binding and into
  // PaymentRouter.settle so each payment is bound to a specific catalog row.
  serviceRegistryAddress: Hex;
  paymentRouterAddress: Hex;
  sanctionsOracleAddress: Hex;
  sanctionsOracleMode: SanctionsOracleMode;
  // The x402 (EIP-3009) adapter is what the facilitator actually submits
  // settle calls to. The router emits the PaymentSettled event but no longer
  // exposes a rail-specific entry point.
  x402AdapterAddress: Hex;
  // Informational only — not submitted by the server-side facilitator flow,
  // but handy for clients that want to advertise which rails are live.
  permitAdapterAddress?: Hex;
  approvalAdapterAddress?: Hex;
  validationRegistryAddress?: Hex;
  // Canonical ERC-8004 ReputationRegistry (0x8004B… singleton). When set,
  // the gateway mirrors every buyer confirmation as public feedback for
  // the provider (facilitator wallet = the ERC-8004 client, EAS
  // attestation = evidence). Unset = mirroring off; everything else works.
  reputationRegistryAddress?: Hex;
  // Daski ReputationStorage — used by the gateway only as a view source.
  // Writes go through EAS; this stays in config so discovery can read
  // aggregate stats for ranking.
  reputationStorageAddress?: Hex;
  usdcAddress: Hex;
  usdcName: string;
  usdcVersion: string;
  facilitatorPrivateKey: Hex;
  whitelistedAgentIds: bigint[];
  cacheRefreshIntervalSeconds: number;
  // How long the discovery cache keeps serving a provider's last-known-good
  // Agent Card when refresh fetches fail (provider restarting, card host
  // down). Past the cap the provider degrades to a card-less catalog entry
  // until a fetch succeeds again. Safe to keep generous: paid flows still
  // require a live signed /quote from the provider, so a stale card can't
  // capture funds while the provider is unreachable.
  cacheMaxStalenessSeconds: number;
  challengeTtlSeconds: number;
  databaseUrl: string;
  publicUrl: string;
  marketplaceTermsUrl: string;
  marketplacePrivacyUrl: string;
  // Public IPFS HTTP gateway used to resolve `ipfs://` agentURIs for
  // optional buyer registration. Trailing slash is required. Override with
  // a self-hosted gateway in production to avoid relying on a public
  // service for liveness.
  ipfsGatewayUrl: string;
  // EAS wiring: the facilitator submits delegated buyer confirmations
  // against the registered schema. All three are required.
  easAddress: Hex;
  easConfirmationSchemaUid: Hex;
  // Outcome schema is passed through to clients that want to check the
  // provider's on-chain attestation exists; gateway itself never writes
  // outcome attestations.
  easOutcomeSchemaUid: Hex;
}

function parseChainId(raw: string | undefined): ChainId {
  const n = Number(raw ?? 8453);
  if (n === 8453 || n === 84532) return n;
  throw new Error(`Unsupported chainId: ${n}`);
}

function networkForChain(chainId: ChainId): "base" | "base-sepolia" {
  return chainId === 8453 ? "base" : "base-sepolia";
}

function parseAgentIds(raw: string | undefined): bigint[] {
  if (!raw) return [];
  try {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const value = BigInt(s);
        if (value < 0n) throw new Error("negative");
        return value;
      });
  } catch {
    throw new Error("WHITELISTED_AGENT_IDS must contain unsigned integers");
  }
}

function positiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function booleanValue(
  name: string,
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be either 'true' or 'false'`);
}

function requireHttpUrl(
  name: string,
  raw: string,
  options: { requireHttps?: boolean } = {},
): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${name} must be an absolute HTTP(S) URL without credentials`);
  }
  if (options.requireHttps && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
  return raw.replace(/\/$/, "");
}

function mcpPath(raw: string | undefined): string {
  const value = raw ?? "/mcp";
  if (
    !/^\/[A-Za-z0-9/_-]*$/.test(value) ||
    value.includes("//") ||
    (value.length > 1 && value.endsWith("/"))
  ) {
    throw new Error("MCP_PATH must be a normalized absolute URL path");
  }
  return value;
}

function optionalAddress(name: string, raw: string | undefined): Hex | undefined {
  if (!raw) return undefined;
  if (!isHexAddress(raw)) {
    throw new Error(`${name} must be a 20-byte hex address, got: ${raw}`);
  }
  return raw.toLowerCase() as Hex;
}

function requireBytes32(name: string, raw: string | undefined): Hex {
  if (!raw) throw new Error(`${name} env var is required`);
  if (!isHex32(raw)) {
    throw new Error(`${name} must be a 32-byte hex value, got: ${raw}`);
  }
  return raw.toLowerCase() as Hex;
}

function requireAddress(name: string, raw: string | undefined): Hex {
  if (!raw) throw new Error(`${name} env var is required`);
  if (!isHexAddress(raw)) {
    throw new Error(`${name} must be a 20-byte hex address, got: ${raw}`);
  }
  return raw.toLowerCase() as Hex;
}

function sanctionsOracleMode(
  raw: string | undefined,
): SanctionsOracleMode {
  if (raw === "production" || raw === "mock") return raw;
  throw new Error(
    "SANCTIONS_ORACLE_MODE must be explicitly set to production or mock",
  );
}

function requireDatabaseUrl(raw: string | undefined): string {
  if (!raw) {
    throw new Error(
      "DATABASE_URL env var is required (e.g. postgresql://user:pass@host:5432/db)",
    );
  }
  return raw;
}

function requirePrivateKey(name: string, raw: string | undefined): Hex {
  if (!raw) throw new Error(`${name} env var is required`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${name} must be a 32-byte hex private key`);
  }
  // Reject the all-zero key. It's the placeholder we ship in .env.example
  // and a tempting `cp .env.example .env` foot-gun: the zero key derives a
  // valid, well-known secp256k1 keypair (public address 0x39443885…), so
  // booting with it would silently use a publicly-compromised facilitator
  // wallet. Fail loudly at config load instead.
  if (/^0x0+$/.test(raw)) {
    throw new Error(
      `${name} cannot be the all-zero key — replace the placeholder in .env`,
    );
  }
  return raw as Hex;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const chainId = parseChainId(env.CHAIN_ID);
  const runtime = loadRuntimeConfig(env);
  const production = runtime.nodeEnv === "production";
  const port = positiveInteger("PORT", env.PORT, 3000, 65535);
  const publicUrl = requireHttpUrl(
    "PUBLIC_URL",
    env.PUBLIC_URL ?? `http://localhost:${port}`,
    { requireHttps: production },
  );
  const oracleAddress = requireAddress(
    "SANCTIONS_ORACLE_ADDRESS",
    env.SANCTIONS_ORACLE_ADDRESS,
  );
  const oracleMode = sanctionsOracleMode(env.SANCTIONS_ORACLE_MODE);
  if (
    chainId === 8453 &&
    oracleAddress !== BASE_MAINNET_SANCTIONS_ORACLE
  ) {
    throw new Error(
      `Base mainnet SANCTIONS_ORACLE_ADDRESS must be ${BASE_MAINNET_SANCTIONS_ORACLE}`,
    );
  }
  if (chainId === 8453 && oracleMode !== "production") {
    throw new Error("Base mainnet SANCTIONS_ORACLE_MODE must be production");
  }
  if (runtime.nodeEnv === "production" && oracleMode === "mock") {
    throw new Error("SANCTIONS_ORACLE_MODE=mock is forbidden in production");
  }
  return {
    ...runtime,
    port,
    mcpEnabled: booleanValue("MCP_ENABLED", env.MCP_ENABLED, true),
    mcpPath: mcpPath(env.MCP_PATH),
    baseRpcUrl: requireHttpUrl(
      "BASE_RPC_URL",
      env.BASE_RPC_URL ?? "https://mainnet.base.org",
      { requireHttps: production },
    ),
    chainId,
    network: networkForChain(chainId),
    identityRegistryAddress: requireAddress(
      "IDENTITY_REGISTRY_ADDRESS",
      env.IDENTITY_REGISTRY_ADDRESS,
    ),
    agentIndexAddress: requireAddress(
      "AGENT_INDEX_ADDRESS",
      env.AGENT_INDEX_ADDRESS,
    ),
    providerRegistryAddress: requireAddress(
      "PROVIDER_REGISTRY_ADDRESS",
      env.PROVIDER_REGISTRY_ADDRESS,
    ),
    serviceRegistryAddress: requireAddress(
      "SERVICE_REGISTRY_ADDRESS",
      env.SERVICE_REGISTRY_ADDRESS,
    ),
    paymentRouterAddress: requireAddress(
      "PAYMENT_ROUTER_ADDRESS",
      env.PAYMENT_ROUTER_ADDRESS,
    ),
    sanctionsOracleAddress: oracleAddress,
    sanctionsOracleMode: oracleMode,
    x402AdapterAddress: requireAddress(
      "X402_ADAPTER_ADDRESS",
      env.X402_ADAPTER_ADDRESS,
    ),
    permitAdapterAddress: optionalAddress(
      "PERMIT_ADAPTER_ADDRESS",
      env.PERMIT_ADAPTER_ADDRESS,
    ),
    approvalAdapterAddress: optionalAddress(
      "APPROVAL_ADAPTER_ADDRESS",
      env.APPROVAL_ADAPTER_ADDRESS,
    ),
    reputationRegistryAddress: optionalAddress(
      "REPUTATION_REGISTRY_ADDRESS",
      env.REPUTATION_REGISTRY_ADDRESS,
    ),
    validationRegistryAddress: optionalAddress(
      "VALIDATION_REGISTRY_ADDRESS",
      env.VALIDATION_REGISTRY_ADDRESS,
    ),
    reputationStorageAddress: optionalAddress(
      "REPUTATION_STORAGE_ADDRESS",
      env.REPUTATION_STORAGE_ADDRESS,
    ),
    easAddress: requireAddress(
      "EAS_ADDRESS",
      env.EAS_ADDRESS ?? "0x4200000000000000000000000000000000000021",
    ),
    easConfirmationSchemaUid: requireBytes32(
      "EAS_CONFIRMATION_SCHEMA_UID",
      env.EAS_CONFIRMATION_SCHEMA_UID,
    ),
    easOutcomeSchemaUid: requireBytes32(
      "EAS_OUTCOME_SCHEMA_UID",
      env.EAS_OUTCOME_SCHEMA_UID,
    ),
    usdcAddress: requireAddress("USDC_ADDRESS", env.USDC_ADDRESS),
    usdcName: env.USDC_NAME ?? "USDC",
    usdcVersion: env.USDC_VERSION ?? "2",
    facilitatorPrivateKey: requirePrivateKey(
      "FACILITATOR_PRIVATE_KEY",
      env.FACILITATOR_PRIVATE_KEY,
    ),
    whitelistedAgentIds: parseAgentIds(env.WHITELISTED_AGENT_IDS),
    cacheRefreshIntervalSeconds: positiveInteger(
      "CACHE_REFRESH_INTERVAL",
      env.CACHE_REFRESH_INTERVAL,
      300,
    ),
    cacheMaxStalenessSeconds: positiveInteger(
      "CACHE_MAX_STALENESS_SECONDS",
      env.CACHE_MAX_STALENESS_SECONDS,
      86400,
    ),
    challengeTtlSeconds: positiveInteger(
      "CHALLENGE_TTL_SECONDS",
      env.CHALLENGE_TTL_SECONDS,
      3600,
    ),
    databaseUrl: requireDatabaseUrl(env.DATABASE_URL),
    publicUrl,
    marketplaceTermsUrl: requireMarketplaceHttpsUrl(
      "MARKETPLACE_TERMS_URL",
      env.MARKETPLACE_TERMS_URL,
    ),
    marketplacePrivacyUrl: requireMarketplaceHttpsUrl(
      "MARKETPLACE_PRIVACY_URL",
      env.MARKETPLACE_PRIVACY_URL,
    ),
    ipfsGatewayUrl:
      requireHttpUrl(
        "IPFS_GATEWAY_URL",
        env.IPFS_GATEWAY_URL ?? "https://ipfs.io/ipfs/",
        { requireHttps: production },
      ) + "/",
  };
}
