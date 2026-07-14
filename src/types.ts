import type {
  CategoryFamily,
  FulfillmentMode,
  ServiceType,
} from "./serviceTaxonomy.js";

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
    // ERC-8004 agentId. Wire-level name retained for compatibility with
    // existing Agent Cards / clients; value is the same.
    erc8004TokenId: string;
    chainId: ChainId;
  };
  categoryFamily: CategoryFamily;
  serviceType: ServiceType;
  jurisdictions: string[];
  fulfillmentMode?: FulfillmentMode;
  serviceDescription: string;
  serviceLifecycle: "one-shot" | "ongoing";
  turnaroundEstimate?: string;
}

export interface OnChainProvider {
  // ERC-8004 agentId (ERC-721 tokenId) — the single canonical identifier.
  agentId: bigint;
  walletAddress: Hex;
  // Resolved from IdentityRegistry.tokenURI(agentId); points to the ERC-8004
  // registration JSON file. The Agent Card endpoint is derived from the
  // `services` array inside that file (or falls back to the registration
  // file itself for backwards-compat with the flat Agent Card scheme).
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
   * card's per-skill daski metadata (`serviceSlug`). Null for legacy
   * cards that don't declare one — those fall back to skillId-as-slug
   * semantics downstream.
   */
  serviceSlug: string | null;
  agentCard: Record<string, unknown>;
}

export interface CachedProvider {
  agentId: bigint;
  walletAddress: Hex;
  agentURI: string;
  /**
   * Back-compat convenience: the FIRST successfully fetched card. Skill-
   * scoped consumers should resolve the right card via
   * `findCardForSkill`; catalog-scoped consumers iterate `cards`.
   */
  agentCard: Record<string, unknown>;
  /**
   * Every Agent Card the provider advertises (one per service). Set by
   * the discovery cache on every successful fetch; mirrors `agentCard`
   * for single-card providers and legacy flat-card layouts. Optional so
   * hand-built fixtures (tests) can stay single-card — consumers go
   * through `cardsOf()`, which falls back to wrapping `agentCard`.
   */
  cards?: ProviderCard[];
  /**
   * Top-level name/description from the ERC-8004 registration file at
   * `agentURI`. These describe the *provider* (operating entity); the
   * agent card's `name`/`description` describe the service offering.
   * Null when the provider serves a flat agent card (pre-ERC-8004) or
   * the registration file omits the field.
   */
  providerName: string | null;
  providerDescription: string | null;
  /**
   * Provider brand mark from the ERC-8004 registration file's `image`
   * field (ERC-721 metadata convention). Null when unset or when the
   * provider serves a flat agent card.
   */
  providerImage: string | null;
  /**
   * Provider homepage from the ERC-8004 registration file's
   * `external_url` field (ERC-721/OpenSea convention). Null when unset.
   */
  providerExternalUrl: string | null;
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
     * serviceSlug, version)` is the serviceId. Resolved from the
     * skill's daski metadata in the Agent Card; falls back to skillId
     * when the provider hasn't declared a slug yet (legacy 1:1
     * cardinality).
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
  // Legacy Daski extension used by the X-PAYMENT-header purchase flow:
  // the serviceRef travels with the payload so the gateway can look up
  // the stored challenge. For the canonical x402 facilitator flow
  // (/verify + /settle), serviceRef comes from paymentRequirements's
  // extra block, not here — keep it optional so both shapes parse.
  serviceRef?: Hex;
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  transaction: string; // tx hash or empty string on failure
  network: "base" | "base-sepolia";
  payer: Hex;
  // Daski extension: the on-chain paymentId and routing info the provider
  // needs to verify the payment and fulfill the task.
  daski?: {
    paymentId: string;
    serviceRef: Hex;
    /**
     * 32-byte hex serviceId, echoed from the on-chain PaymentSettled
     * event so providers / clients see exactly which service row was
     * paid for. Absent only on legacy responses; new settlements always
     * carry it.
     */
    serviceId?: Hex;
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

// ── Persisted challenge row (internal, not on the wire) ──

export interface StoredChallenge {
  serviceRef: Hex;
  providerTokenId: bigint;
  buyerTokenId: bigint;
  // The A2A skill the buyer requested (off-chain identifier). Distinct
  // from serviceSlug — see DaskiRequirementsExtra.daski.
  skillId: string | null;
  // The on-chain service slug baked into the serviceId hash.
  // Resolved from the skill's daski metadata in the provider Agent Card
  // at challenge-issue time; persisted so the (slug, version) tuple
  // that produced this serviceId is fully recoverable for analytics.
  serviceSlug: string;
  // The version baked into the serviceId hash. Stored alongside
  // serviceSlug so the gateway can re-derive serviceId without a
  // contract round-trip.
  serviceVersion: string;
  // 32-byte hex serviceId — `keccak256(abi.encode(providerAgentId, serviceSlug, version))`.
  // Persisted on the challenge so /verify can cross-check the on-chain
  // PaymentSettled event's serviceId field rather than trusting the
  // adapter call args alone.
  serviceId: Hex;
  amount: bigint;
  providerA2AUrl: string;
  // Wallet address that the gateway baked into the EIP-712 typed-data's
  // `from` field at challenge issuance. /verify enforces that the
  // submitted authorization's `from` matches — closes a cross-wallet
  // settlement window (an unrelated wallet whose signature would settle
  // on-chain but leave the original challenge dangling).
  walletAddress: Hex;
  createdAt: Date;
  expiresAt: Date;
  status: "pending" | "paid" | "expired";
  paymentId: bigint | null;
  transactionHash: Hex | null;
  // Set when status transitions pending → paid. Used as the "settled at"
  // timestamp for the public activity feed.
  verifiedAt: Date | null;
  // 32-byte UID of the buyer's EAS confirmation attestation, persisted by
  // /confirm/:paymentId on success. Null when no confirmation has landed,
  // or for rows that pre-date migration 005. Latest UID wins — confirmation
  // revisions overwrite. Used by the public activity feed to deep-link to
  // the canonical attestation on an EAS explorer.
  confirmationAttestationUid: Hex | null;
  // Which settlement rail this challenge runs on:
  //   'daski'    — the gateway's own facilitator submits X402Adapter.settle
  //                (structured nonce, split runs in the same tx).
  //   'external' — an external x402 facilitator (CDP) settles the EIP-3009
  //                transfer; the gateway then attributes the split via
  //                DirectTransferAdapter. Used by the Bazaar-listable route.
  rail: "daski" | "external";
  // External rail only: the client-chosen EIP-3009 nonce from the payment
  // payload. (walletAddress, authNonce) is the idempotency key for paid
  // retries — external clients don't know Daski serviceRefs.
  authNonce: Hex | null;
  // External rail only: tx hash of the external facilitator's settle
  // (the bare transferWithAuthorization that moved buyer funds into the
  // router). Persisted before the attribution tx so a crash between the
  // two is recoverable. `transactionHash` holds the attribution tx.
  externalSettleTx: Hex | null;
  // Provider quote commitment (provider audit item 1.1). When set, the
  // challenge's serviceRef IS the provider's quote commitment hash
  // (keccak256(canonicalJson(signedQuotePayload))) and these two fields
  // must be forwarded as A2A metadata.quoteId / metadata.quoteSignature
  // at task-submit time — the provider rejects paid tasks without them.
  // Null for providers that don't enforce quote commitments.
  quoteId: string | null;
  quoteSignature: Hex | null;
  // Commitment to the canonical serviceArgs accepted by the provider.
  // Persisted so retries and submit-time binding checks use the exact
  // request hash from the signed quote rather than recomputing it from
  // potentially transformed arguments.
  quoteRequestHash: Hex | null;
  // Quote expiry (provider-side TTL, ~120s). Bounds the challenge's own
  // expiresAt so the gateway never settles a payment whose quote is
  // already dead — that would capture funds the provider then refuses.
  quoteExpiresAt: Date | null;
}
