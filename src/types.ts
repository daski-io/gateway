import type {
  CategoryFamily,
  FulfillmentMode,
  ServiceType,
} from "./serviceTaxonomy.js";
import type {
  AgentAuthority,
  ProviderLegalMetadata,
  ServiceLegal,
} from "./legal/types.js";
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
  isWhitelisted: boolean;
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

// ── x402 wire types ──────────────────────────────────────────────
// Shapes match github.com/coinbase/x402 v1 spec. `extra` is used to
// carry Daski-specific context (providerTokenId, buyerTokenId, serviceRef)
// from the challenge → payload → settlement response without polluting
// the top-level spec fields.

/**
 * On-chain rail a crypto-native buyer could use to settle this payment.
 * The gateway's own facilitator flow continues to submit exclusively via
 * `x402` (EIP-3009); other rails are advertised informationally so that
 * advanced buyers who prefer to pay directly can pick an adapter.
 */
export interface DaskiRail {
  /** Stable short name. `x402` = EIP-3009, `permit` = EIP-2612, `approval` = ERC-20 approve. */
  name: "x402" | "permit" | "approval";
  /** Signature / approval scheme the adapter expects. */
  kind: "eip3009" | "eip2612" | "erc20-approve";
  /** Adapter contract address (callable via PaymentRouter's whitelist). */
  adapter: Hex;
}

export interface DaskiRequirementsExtra {
  name: string; // USDC EIP-712 domain name
  version: string; // USDC EIP-712 domain version
  daski: {
    providerTokenId: string;
    buyerTokenId: string;
    /**
     * The A2A skill the buyer is invoking (off-chain identifier like
     * `register-domain`). Distinct from `serviceSlug` (the on-chain
     * on-chain service identifier — one slug can map to many skills).
     */
    skillId: string | null;
    /**
     * On-chain service identifier — `keccak256(providerAgentId,
     * serviceSlug, version)` is the serviceId. Resolved from the skill's
     * Daski metadata in the Agent Card.
     */
    serviceSlug: string;
    /**
     * Free-form service version. Defaults to "1" when the provider's
     * agent card does not advertise one. Combined with serviceSlug and
     * providerTokenId to derive serviceId.
     */
    serviceVersion: string;
    /**
     * 32-byte hex serviceId. Identifies the row in ServiceRegistry this
     * payment is for. Computed as
     * `keccak256(abi.encode(uint256 providerAgentId, string serviceSlug, string version))`.
     * Clients that sign the EIP-3009 nonce themselves must include this
     * value in the bound 3-tuple — the X402Adapter rejects calls whose
     * nonce does not match.
     */
    serviceId: Hex;
    serviceRef: Hex;
    /**
     * Token the buyer should authorize. Previously implicit USDC. Explicit
     * now that the router supports multiple accepted tokens — lets clients
     * disambiguate when the asset field is overloaded for display.
     */
    token: Hex;
    /**
     * Rails the PaymentRouter has whitelisted adapters for. Advisory only —
     * the gateway's /settle flow still uses x402. Optional adapters are
     * present iff their address is configured in env.
     */
    rails: DaskiRail[];
    /**
     * Tokens the router is known to accept. Mirrors the router's on-chain
     * acceptedTokens mapping but is sourced from gateway config (single
     * USDC for the MVP) — keeps the challenge issue path a pure function
     * with no extra RPC hop.
     */
    acceptedTokens: Hex[];
    /**
     * Fully-baked EIP-712 typed-data block the buyer's wallet must sign.
     * This is what makes Daski wallet-agnostic: the gateway computes domain,
     * types, primaryType, and the entire message (including a fresh nonce
     * and validBefore bound to the challenge TTL) so any wallet that
     * implements generic EIP-712 signing — AgentKit, CDP Wallet MCP,
     * MetaMask, viem-based — can sign without reconstructing the payload.
     *
     * The message's `from` field is the wallet address the agent supplied
     * when calling /purchase. The wallet must sign with that exact address.
     * The agent then assembles the paymentPayload as:
     *   { x402Version: 1, scheme, network,
     *     payload: { signature, authorization: <this message> } }
     * and posts to /settle.
     */
    eip712TypedData: Eip712TypedData;
    /**
     * Daski-specific extension flagging the on-chain submission mode for
     * this challenge:
     *   - "settle-only" — buyer is already registered (`buyerTokenId` ≠ 0);
     *     daski_settle_payment submits a vanilla x402 settle.
     *   - "atomic-register" — buyer has no agentId yet (`buyerTokenId` = 0);
     *     daski_settle_payment expects a `registration` field with a signed
     *     RegisterAgent payload and bundles registration + payment into one
     *     atomic tx via X402Adapter.settleWithRegistration.
     */
    settlementMode: "settle-only" | "atomic-register";
    /**
     * Provider quote commitment backing this challenge. Present iff the
     * provider issued a signed quote (all current paid skills). The
     * serviceRef above IS quote.serviceRef; buyers submitting tasks
     * directly over A2A (bypassing daski_submit_task, which injects them
     * automatically) must copy quoteId + quoteSignature into the task's
     * daski metadata or the provider rejects the paid task.
     */
    quote?: {
      quoteId: string;
      quoteSignature: Hex;
      /** ISO timestamp — settle AND submit before this or re-quote. */
      expiresAt: string;
    };
    legal: ServiceLegal;
    agentAuthority: AgentAuthority;
    purchaseNotice: string;
  };
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

export interface PaymentRequirements {
  scheme: "exact";
  network: "base" | "base-sepolia";
  /**
   * CAIP-2 chain identifier (`eip155:<chainId>`) — x402 v2 forward-compat
   * dual-emit alongside the v1 `network` enum. v1 facilitators and the CDP
   * facilitator read `network`; v2 facilitators (OpenZeppelin Relayer's
   * x402 plugin, x402-rs v2) read `chainId`. Both point at the same chain.
   */
  chainId: string;
  maxAmountRequired: string; // atomic units, decimal string
  resource: string;
  description: string;
  mimeType: string;
  payTo: Hex; // the PaymentRouter address
  maxTimeoutSeconds: number;
  asset: Hex; // USDC address
  outputSchema: Record<string, unknown> | null;
  extra: DaskiRequirementsExtra;
}

export interface PaymentRequirementsResponse {
  x402Version: number;
  legal: ServiceLegal;
  agentAuthority: AgentAuthority;
  purchaseNotice: string;
  accepts: PaymentRequirements[];
  error?: string;
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
  signature: Hex; // 0x-prefixed 65-byte signature
  authorization: ExactEvmAuthorization;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: "exact";
  network: "base" | "base-sepolia";
  payload: ExactEvmPayload;
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  retryable?: boolean;
  transaction: string; // tx hash or empty string on failure
  network: "base" | "base-sepolia";
  payer: Hex;
  // Daski extension: the on-chain paymentId and routing info the provider
  // needs to verify the payment and fulfill the task.
  daski?: {
    paymentId: string;
    serviceRef: Hex;
    /**
     * 32-byte hex serviceId, echoed from the on-chain PaymentSettled event
     * so providers and clients see exactly which service row was paid for.
     */
    serviceId: Hex;
    providerTokenId: string;
    buyerTokenId: string;
    amount: string;
    providerA2AUrl: string;
    /**
     * Atomic-register-and-settle only: true when the buyer's agentId was
     * minted in the same tx as this settlement. Absent or false otherwise.
     */
    registered?: boolean;
    /**
     * Provider quote credentials for the settled challenge (audit 1.1).
     * daski_submit_task injects them automatically; buyers dispatching
     * tasks directly over A2A must copy them into the task's daski
     * metadata (`quoteId`, `quoteSignature`) or the provider rejects the
     * paid task. Absent for challenges without quote enforcement.
     */
    quoteId?: string;
    quoteSignature?: Hex;
  };
}
