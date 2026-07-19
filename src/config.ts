import type { ChainId, Hex } from "./types.js";
import { requireMarketplaceHttpsUrl } from "./legal/validation.js";
import {
  loadRuntimeConfig,
  type RuntimeConfig,
} from "./runtimeConfig.js";

export const DASKI_A2A_EXTENSION_URI = "https://daski.xyz/a2a/v1";

export const X402_VERSION = 1;

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
  // gasless registerWithSig; the companion that fills the canonical
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
  // ── External-facilitator rail (x402 Bazaar listability) ──────────────
  // DirectTransferAdapter — attributes payments that an EXTERNAL x402
  // facilitator (CDP) settled as bare EIP-3009 transfers into the router.
  // The Bazaar-facing resource route is mounted iff this is set.
  directAdapterAddress?: Hex;
  // Base URL of the external facilitator's /verify + /settle endpoints.
  // Defaults per network: x402.org for Base Sepolia (no auth), the CDP
  // facilitator for Base mainnet. Note that Bazaar INDEXING only happens
  // for settlements processed by the CDP facilitator.
  externalFacilitatorUrl: string;
  // Raw `Authorization` header value for the external facilitator. The CDP
  // facilitator requires a CDP API key JWT for mainnet /settle; testnet
  // facilitators are typically unauthenticated. Optional.
  externalFacilitatorAuthHeader?: string;
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
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => BigInt(s));
}

function optionalAddress(name: string, raw: string | undefined): Hex | undefined {
  if (!raw) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`${name} must be a 20-byte hex address, got: ${raw}`);
  }
  return raw.toLowerCase() as Hex;
}

function requireBytes32(name: string, raw: string | undefined): Hex {
  if (!raw) throw new Error(`${name} env var is required`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${name} must be a 32-byte hex value, got: ${raw}`);
  }
  return raw.toLowerCase() as Hex;
}

function requireAddress(name: string, raw: string | undefined): Hex {
  if (!raw) throw new Error(`${name} env var is required`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`${name} must be a 20-byte hex address, got: ${raw}`);
  }
  return raw.toLowerCase() as Hex;
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
  const port = Number(env.PORT ?? 3000);
  return {
    ...loadRuntimeConfig(env),
    port,
    mcpEnabled: (env.MCP_ENABLED ?? "true") !== "false",
    mcpPath: env.MCP_PATH ?? "/mcp",
    baseRpcUrl: env.BASE_RPC_URL ?? "https://mainnet.base.org",
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
    directAdapterAddress: optionalAddress(
      "DIRECT_ADAPTER_ADDRESS",
      env.DIRECT_ADAPTER_ADDRESS,
    ),
    externalFacilitatorUrl: requireMarketplaceHttpsUrl(
      "EXTERNAL_FACILITATOR_URL",
      env.EXTERNAL_FACILITATOR_URL ??
        (chainId === 8453
          ? "https://api.cdp.coinbase.com/platform/v2/x402"
          : "https://x402.org/facilitator"),
    ).replace(/\/$/, ""),
    externalFacilitatorAuthHeader: env.EXTERNAL_FACILITATOR_AUTH_HEADER,
    whitelistedAgentIds: parseAgentIds(env.WHITELISTED_AGENT_IDS),
    cacheRefreshIntervalSeconds: Number(env.CACHE_REFRESH_INTERVAL ?? 300),
    cacheMaxStalenessSeconds: Number(env.CACHE_MAX_STALENESS_SECONDS ?? 86400),
    challengeTtlSeconds: Number(env.CHALLENGE_TTL_SECONDS ?? 3600),
    databaseUrl: requireDatabaseUrl(env.DATABASE_URL),
    publicUrl: env.PUBLIC_URL ?? `http://localhost:${port}`,
    marketplaceTermsUrl: requireMarketplaceHttpsUrl(
      "MARKETPLACE_TERMS_URL",
      env.MARKETPLACE_TERMS_URL,
    ),
    marketplacePrivacyUrl: requireMarketplaceHttpsUrl(
      "MARKETPLACE_PRIVACY_URL",
      env.MARKETPLACE_PRIVACY_URL,
    ),
    ipfsGatewayUrl: (env.IPFS_GATEWAY_URL ?? "https://ipfs.io/ipfs/").replace(
      /\/?$/,
      "/",
    ),
  };
}
