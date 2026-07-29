import type {
  CategoryFamily,
  FulfillmentMode,
  ServiceType,
} from "./serviceTaxonomy.js";
import type {
  ProviderLegalMetadata,
} from "./legal/types.js";
import type {
  Network,
  PaymentPayload as X402PaymentPayload,
  PaymentRequired,
  PaymentRequirements as X402PaymentRequirements,
  SettleResponse as X402SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
export type {
  SettlementState,
  StoredChallenge,
} from "./payment/challengeTypes.js";

// ── Shared types used across the gateway ──

export type Hex = `0x${string}`;

export type ChainId = 8453 | 84532;

export interface DaskiMarketplaceExtension {
  pricing: {
    baseAmount: string;
    currency: "USDC";
    variablePricing: boolean;
    billingModel: "one-time" | "subscription";
    subscriptionPeriod?: string;
  };
  onChainReferences: {
    registryAddress: Hex;
    paymentRouterAddress: Hex;
    chainId: ChainId;
  };
  categoryFamily: CategoryFamily;
  serviceType: ServiceType;
  jurisdictions: string[];
  fulfillmentMode?: FulfillmentMode;
  serviceDescription: string;
  serviceLifecycle: "one-shot" | "ongoing";
  turnaroundEstimate?: string;
  /** Additional HTTPS origins allowed to host artifacts for this service. */
  artifactOrigins?: string[];
}

export interface OnChainProvider {
  // ERC-8004 agentId (ERC-721 tokenId) — the single canonical identifier.
  agentId: bigint;
  walletAddress: Hex;
  // Resolved from IdentityRegistry.tokenURI(agentId); points to the ERC-8004
  // registration JSON file. Agent Card endpoints are derived from its
  // `services` array.
  agentURI: string;
  registrationTime: bigint;
  isActive: boolean;
}

/**
 * One Agent Card advertised by a provider's ERC-8004 registration file.
 * Multi-service providers list one `services[name="A2A"]` entry per
 * service; each resolves to its own card with its own skills, pricing,
 * and A2A endpoint.
 */
export interface ProviderCard {
  /** The endpoint the card was fetched from (registration `services[].endpoint`). */
  endpoint: string;
  /**
   * The on-chain service slug this card represents, extracted from the
   * card's per-skill daski metadata (`serviceSlug`).
   */
  serviceSlug: string;
  agentCard: Record<string, unknown>;
}

export interface CachedProvider {
  agentId: bigint;
  walletAddress: Hex;
  agentURI: string;
  /** Every Agent Card the provider advertises, one per service. */
  cards: ProviderCard[];
  /**
   * Top-level name/description from the ERC-8004 registration file at
   * `agentURI`. These describe the *provider* (operating entity); the
   * agent card's `name`/`description` describe the service offering.
   * Null when the registration file omits the field.
   */
  providerName: string | null;
  providerDescription: string | null;
  /**
   * Provider brand mark from the ERC-8004 registration file's `image`
   * field (ERC-721 metadata convention). Null when unset.
   */
  providerImage: string | null;
  /**
   * Provider homepage from the ERC-8004 registration file's
   * `external_url` field (ERC-721/OpenSea convention). Null when unset.
   */
  providerExternalUrl: string | null;
  /** Required contracting identity and public legal-document links. */
  providerLegal: ProviderLegalMetadata | null;
  lastFetched: Date;
  fetchError: string | null;
}

// ── x402 V2 wire types ───────────────────────────────────────────

export type PaymentRequirements = X402PaymentRequirements;
export type PaymentPayload = X402PaymentPayload;
export type SettlementResponse = X402SettleResponse;
export type {
  Network,
  PaymentRequired,
  SupportedResponse,
  VerifyResponse,
};

export interface DaskiX402Info {
  profile: "1";
  x402Adapter: Hex;
  paymentRouter: Hex;
  serviceRef: Hex;
  providerAgentId: string;
  buyerAgentId: string;
  serviceId: Hex;
  skillId: string;
  serviceSlug: string;
  serviceVersion: string;
  providerA2AUrl: string;
  quote: {
    id: string;
    signature: Hex;
    expiresAt: string;
  };
  settlementMode: "settle-only" | "register-and-settle";
  warnings?: string[];
}

export interface DaskiX402Declaration {
  info: DaskiX402Info;
  schema: Record<string, unknown>;
}

export interface DaskiX402Receipt {
  paymentId: string;
  serviceRef: Hex;
  providerAgentId: string;
  buyerAgentId: string;
  serviceId: Hex;
  skillId: string;
  providerA2AUrl: string;
  registered: boolean;
  quoteId: string;
  quoteSignature: Hex;
}

export interface Eip712TypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Hex;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  // Message values are serialized as JSON-friendly primitives. Numeric
  // fields (uint256/uint64) must be decimal strings — JS numbers can't
  // safely hold those ranges. Boolean fields (bool) must be JSON booleans
  // — viem's signTypedData strictly validates and rejects "true"/"false"
  // string forms. Hex-bytes fields (bytes/bytes32/address) are 0x-prefixed
  // strings.
  message: Record<string, string | boolean | number>;
}

export interface ExactEvmAuthorization {
  from: Hex;
  to: Hex;
  value: string; // atomic units, decimal string
  validAfter: string; // unix seconds, decimal string
  validBefore: string; // unix seconds, decimal string
  nonce: Hex; // 32-byte hex
}

export interface ExactEvmPayload {
  signature: Hex; // opaque ECDSA or ERC-1271 signature bytes
  authorization: ExactEvmAuthorization;
  nonceSalt: Hex;
}
