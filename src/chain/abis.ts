import { sanctionsErrorAbi } from "./sanctionsErrors.js";

// Contract ABI fragments — single source of truth for the gateway.
// Mirrors the on-chain contracts in the `daski` repo.

// ── ERC-8004 Identity Registry (canonical per-chain singleton) ──────────
//
// Daski no longer deploys an identity registry of its own — agents live in
// the CANONICAL ERC-8004 IdentityRegistry (0x8004A… per chain). The
// canonical surface has no reverse lookup or delegated registration;
// those gaps are filled by the Daski AgentIndex (agentIndexAbi below).

export const identityRegistryAbi = [
  {
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    // Canonical live wallet for an agentId. The audit refactor dropped the
    // `walletAddress` field from ProviderRegistry.Provider entirely —
    // `IdentityRegistry.getAgentWallet` is now the sole source of a
    // provider's payee wallet: it is what PaymentRouter resolves the payee
    // against, and what survives ERC-8004 wallet rotation. The gateway
    // reads this for cache-side wallet resolution so discovery reflects the
    // live wallet. NOTE: the canonical registry never auto-sets agentWallet
    // (registration and transfers leave it zero) — buyer agents minted via
    // AgentIndex.registerWithSig read as address(0) here; ownership is
    // their control proof.
    type: "function",
    name: "getAgentWallet",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

// ── Daski AgentIndex ─────────────────────────────────────────────────────
//
// Daski-local companion to the canonical registry (daski/src/AgentIndex.sol).
// Fills the two gaps the canonical registry leaves open: a VERIFIED
// wallet → agentId reverse lookup (`resolve`, re-checked against the
// canonical registry on every read; stale bindings self-heal to 0) and
// delegated onboarding (`registerWithSig` mints on the canonical registry,
// transfers the NFT to the wallet, records the binding — one tx).

export const agentIndexAbi = [
  {
    // Verified reverse lookup — wallet → agentId. Returns 0 unless the
    // wallet is currently the agent's ERC-721 owner or verified agentWallet
    // on the canonical registry.
    type: "function",
    name: "resolve",
    inputs: [{ name: "wallet", type: "address" }],
    // v0.6.0 returns (agentId, found); found=false ⇒ agentId is 0.
    outputs: [
      { name: "agentId", type: "uint256" },
      { name: "found", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    // Per-wallet nonce for registerWithSig. Buyer reads this when building
    // the EIP-712 RegisterAgent typed-data; bumps after each registration.
    type: "function",
    name: "registrationNonce",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    // Delegated registration: the buyer signs an EIP-712 RegisterAgent
    // struct off-chain (domain: name "Daski AgentIndex", verifyingContract
    // = the AgentIndex proxy). The buyer can submit it directly, or the
    // payment adapter can include it in an atomic purchase. The AgentIndex
    // mints on the canonical registry, transfers the NFT to `wallet`, and
    // records the wallet → agentId binding.
    type: "function",
    name: "registerWithSig",
    inputs: [
      { name: "agentURI", type: "string" },
      { name: "wallet", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    // Bind the caller to an agent it already controls on the canonical
    // registry (owner or verified agentWallet). Bring-your-own-agent path.
    type: "function",
    name: "claim",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "AgentRegistered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "wallet", type: "address", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
    ],
  },
] as const;

// ── Daski ProviderRegistry ──────────────────────────────────────────────

export const providerRegistryAbi = [
  {
    type: "function",
    name: "getProvider",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "agentId", type: "uint256" },
          { name: "registrationTime", type: "uint256" },
          { name: "isActive", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getProviderCount",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "providerIds",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ── Daski PaymentRouter ─────────────────────────────────────────────────
//
// The router is now rail-agnostic — adapters handle the specifics of how
// funds arrive. The gateway consumes PaymentSettled (emitted by the router).

export const paymentRouterAbi = [
  {
    // Full PaymentRecord for one paymentId — the authoritative on-chain
    // source of (buyer, provider, service) for a settled payment. Unknown
    // paymentIds revert. The canonical-feedback mirror reads this to resolve
    // both the provider and whether feedback is reputation-eligible.
    type: "function",
    name: "getPayment",
    inputs: [{ name: "paymentId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "buyerAgentId", type: "uint256" },
          { name: "providerAgentId", type: "uint256" },
          { name: "serviceId", type: "bytes32" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "cachedBuyerWallet", type: "address" },
          { name: "cachedProviderOwner", type: "address" },
          { name: "cachedProviderWallet", type: "address" },
          { name: "serviceRef", type: "bytes32" },
          { name: "paidAt", type: "uint256" },
          { name: "reputationEligible", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "PaymentSettled",
    inputs: [
      { name: "paymentId", type: "uint256", indexed: true },
      { name: "serviceRef", type: "bytes32", indexed: true },
      // Indexed third arg in the post-refactor router (PaymentRouter v2,
      // Base Sepolia 2026-05). Subgraphs filter on this for cheap
      // per-service queries — same convention as the ERC-8004 NewFeedback
      // tag1 path, just on the settlement side.
      { name: "serviceId", type: "bytes32", indexed: true },
      { name: "buyerAgentId", type: "uint256", indexed: false },
      { name: "providerAgentId", type: "uint256", indexed: false },
      { name: "token", type: "address", indexed: false },
      { name: "totalAmount", type: "uint256", indexed: false },
      { name: "providerAmount", type: "uint256", indexed: false },
      { name: "commission", type: "uint256", indexed: false },
    ],
  },
] as const;

// ── Daski ReputationStorage ─────────────────────────────────────────────
//
// EAS schema resolver that maintains aggregate counters per
// (provider, buyer). Gateway only reads the views — writes happen via EAS
// attestations that the resolver intercepts. The two getters below are the
// shape consumed by the public service-detail endpoint to surface
// completion / buyer-confirmation rates on the marketing site.

export const reputationStorageAbi = [
  {
    type: "function",
    name: "getProviderStats",
    inputs: [{ name: "providerAgentId", type: "uint256" }],
    outputs: [
      { name: "completed", type: "uint256" },
      { name: "failed", type: "uint256" },
      { name: "canceled", type: "uint256" },
      { name: "confirmed", type: "uint256" },
      { name: "notConfirmed_", type: "uint256" },
      { name: "transactions", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getBuyerStats",
    inputs: [{ name: "buyerAgentId", type: "uint256" }],
    outputs: [
      { name: "transactions", type: "uint256" },
      { name: "confirmed", type: "uint256" },
      { name: "notConfirmed_", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    // Per-service counters (post-refactor). Same shape as getProviderStats
    // plus a totalRefunded entry. Service-level discovery ranking and the
    // marketing site's per-service detail card both read this.
    type: "function",
    name: "getServiceStats",
    inputs: [{ name: "serviceId", type: "bytes32" }],
    outputs: [
      { name: "completed", type: "uint256" },
      { name: "failed", type: "uint256" },
      { name: "canceled", type: "uint256" },
      { name: "confirmed", type: "uint256" },
      { name: "notConfirmed_", type: "uint256" },
      { name: "totalRefunded", type: "uint256" },
      { name: "transactions", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    // Per-paymentId reputation record. Carries the provider-attested outcome
    // and the on-chain-derived `fulfillmentTime` (block.timestamp at outcome
    // attest minus PaymentRouter.paidAt — gameless wall-clock turnaround).
    // For unknown paymentIds the contract returns a zero-init struct; the
    // gateway treats `paymentId == 0` as "no record yet".
    type: "function",
    name: "getRecord",
    inputs: [{ name: "paymentId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "paymentId", type: "uint256" },
          { name: "providerAgentId", type: "uint256" },
          { name: "buyerAgentId", type: "uint256" },
          { name: "serviceId", type: "bytes32" },
          // Solidity enum encoded as uint8. 0=Completed, 1=Failed, 2=Canceled.
          { name: "outcome", type: "uint8" },
          // Solidity enum encoded as uint8. 0=Pending, 1=Confirmed, 2=NotConfirmed.
          { name: "confirmation", type: "uint8" },
          { name: "outcomeAttestationDelay", type: "uint256" },
          { name: "outcomeTimestamp", type: "uint256" },
          { name: "confirmationTimestamp", type: "uint256" },
          { name: "outcomeRecorded", type: "bool" },
          { name: "currentConfirmationUid", type: "bytes32" },
          { name: "reputationEligible", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

// ── Canonical ERC-8004 ReputationRegistry ───────────────────────────────
//
// Public per-chain feedback singleton (0x8004B…), pinned to the same spec
// commit as the canonical IdentityRegistry. The gateway acts as an
// orchestrator-client: after a buyer confirmation lands on EAS, the
// facilitator wallet mirrors it here as public feedback for the provider
// so Daski reputation is portable across the ERC-8004 ecosystem. Feedback
// indices are per-(agentId, clientAddress) and 1-based; getLastIndex
// returns the most recent index this client used (0 = none yet), which is
// what revokeFeedback needs for revisions.

export const reputationRegistryAbi = [
  {
    type: "event",
    name: "NewFeedback",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "clientAddress", type: "address", indexed: true },
      { name: "feedbackIndex", type: "uint64", indexed: false },
      { name: "value", type: "int128", indexed: false },
      { name: "valueDecimals", type: "uint8", indexed: false },
      { name: "indexedTag1", type: "string", indexed: true },
      { name: "tag1", type: "string", indexed: false },
      { name: "tag2", type: "string", indexed: false },
      { name: "endpoint", type: "string", indexed: false },
      { name: "feedbackURI", type: "string", indexed: false },
      { name: "feedbackHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "function",
    name: "giveFeedback",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // Soft revocation — the record stays and isRevoked flips. The revision
    // flow accepts only the canonical "already revoked" result as success.
    type: "function",
    name: "revokeFeedback",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "feedbackIndex", type: "uint64" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getLastIndex",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddress", type: "address" },
    ],
    outputs: [{ name: "", type: "uint64" }],
    stateMutability: "view",
  },
] as const;

// ── X402Adapter (EIP-3009) ──────────────────────────────────────────────

export const x402AdapterAbi = [
  {
    type: "function",
    name: "settle",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "serviceRef", type: "bytes32" },
      { name: "providerAgentId", type: "uint256" },
      // The allowlisted facilitator resolves serviceId from the persisted
      // challenge and binds settlement to that ServiceRegistry row.
      { name: "serviceId", type: "bytes32" },
      {
        name: "auth",
        type: "tuple",
        components: [
          { name: "from", type: "address" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
          { name: "signature", type: "bytes" },
        ],
      },
      { name: "nonceSalt", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    // Atomic register-and-settle. If `auth.from` has no agentId, the
    // buyer's RegisterAgent signature mints one on the canonical registry
    // (via AgentIndex.registerWithSig) in the same tx as the EIP-3009
    // transfer. Either both succeed or both revert. Used by the gateway
    // when a fresh wallet's first action is a purchase.
    type: "function",
    name: "settleWithRegistration",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "serviceRef", type: "bytes32" },
      { name: "providerAgentId", type: "uint256" },
      { name: "serviceId", type: "bytes32" },
      {
        name: "auth",
        type: "tuple",
        components: [
          { name: "from", type: "address" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
          { name: "signature", type: "bytes" },
        ],
      },
      { name: "nonceSalt", type: "bytes32" },
      { name: "agentURI", type: "string" },
      { name: "registrationDeadline", type: "uint256" },
      { name: "registrationSignature", type: "bytes" },
    ],
    outputs: [
      { name: "buyerAgentId", type: "uint256" },
      { name: "paymentId", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
] as const;

// ── EAS (subset the gateway uses) ───────────────────────────────────────
//
// The gateway acts as the relayer for buyer confirmations: it receives a
// signed AttestByDelegation payload from the buyer and submits it via
// EAS.attestByDelegation so the buyer never pays gas.

export const easAbi = [
  {
    type: "function",
    name: "attestByDelegation",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
          {
            name: "signature",
            type: "tuple",
            components: [
              { name: "v", type: "uint8" },
              { name: "r", type: "bytes32" },
              { name: "s", type: "bytes32" },
            ],
          },
          { name: "attester", type: "address" },
          { name: "deadline", type: "uint64" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    // EIP-712 nonce per attester — buyer includes it in the signed payload.
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// ── ERC-20 / EIP-3009 USDC ──────────────────────────────────────────────

export const usdcAbi = [
  {
    type: "function",
    name: "authorizationState",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

// ── Known custom-error fragments (for revert decoding only) ─────────────
//
// Viem can only decode a custom error if its ABI fragment is present in the
// ABI passed to the call. The contracts above don't declare errors thrown
// by their dependencies (OpenZeppelin ERC721 used inside IdentityRegistry,
// Initializable inside the proxies, ECDSA inside SignatureChecker), so when
// one of those reverts the gateway sees bare "execution reverted" and the
// caller learns nothing.
//
// Concatenate these into the ABI used at simulate-time so the decoded error
// surfaces as e.g. `ERC721InvalidReceiver(0x0000…)` instead of the generic
// fallback. Keep this list narrow — only errors actually throwable along
// the gateway's on-chain paths.
export const knownErrorAbis = [
  ...sanctionsErrorAbi,
  // OpenZeppelin ERC721 v5 — the canonical IdentityRegistry mints via
  // _safeMint and AgentIndex.registerWithSig transfers the NFT onward, so
  // the receiver/sender errors are reachable through registerWithSig.
  {
    type: "error",
    name: "ERC721InvalidOwner",
    inputs: [{ name: "owner", type: "address" }],
  },
  {
    type: "error",
    name: "ERC721NonexistentToken",
    inputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "error",
    name: "ERC721IncorrectOwner",
    inputs: [
      { name: "sender", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "owner", type: "address" },
    ],
  },
  {
    type: "error",
    name: "ERC721InvalidSender",
    inputs: [{ name: "sender", type: "address" }],
  },
  {
    type: "error",
    name: "ERC721InvalidReceiver",
    inputs: [{ name: "receiver", type: "address" }],
  },
  {
    type: "error",
    name: "ERC721InsufficientApproval",
    inputs: [
      { name: "operator", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC721InvalidApprover",
    inputs: [{ name: "approver", type: "address" }],
  },
  {
    type: "error",
    name: "ERC721InvalidOperator",
    inputs: [{ name: "operator", type: "address" }],
  },

  // OpenZeppelin Initializable — UUPS proxies behind every Daski contract.
  { type: "error", name: "InvalidInitialization", inputs: [] },
  { type: "error", name: "NotInitializing", inputs: [] },

  // OpenZeppelin ECDSA — SignatureChecker uses ECDSA.tryRecover internally.
  // SignatureChecker itself swallows these and returns false (causing a
  // require-string revert in AgentIndex.registerWithSig), but raw
  // ECDSA.recover is also used in places, and these errors travel up
  // unwrapped.
  { type: "error", name: "ECDSAInvalidSignature", inputs: [] },
  {
    type: "error",
    name: "ECDSAInvalidSignatureLength",
    inputs: [{ name: "length", type: "uint256" }],
  },
  {
    type: "error",
    name: "ECDSAInvalidSignatureS",
    inputs: [{ name: "s", type: "bytes32" }],
  },

  // EAS errors thrown by attestByDelegation along the confirm-delivery path.
  { type: "error", name: "AccessDenied", inputs: [] },
  { type: "error", name: "DeadlineExpired", inputs: [] },
  { type: "error", name: "InvalidAttestation", inputs: [] },
  { type: "error", name: "InvalidExpirationTime", inputs: [] },
  { type: "error", name: "InvalidLength", inputs: [] },
  { type: "error", name: "InvalidNonce", inputs: [] },
  { type: "error", name: "InvalidRegistry", inputs: [] },
  { type: "error", name: "InvalidRevocation", inputs: [] },
  { type: "error", name: "InvalidSchema", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
  { type: "error", name: "InvalidVerifier", inputs: [] },
  { type: "error", name: "Irrevocable", inputs: [] },
  { type: "error", name: "NotFound", inputs: [] },
  { type: "error", name: "NotPayable", inputs: [] },
  { type: "error", name: "WrongSchema", inputs: [] },
] as const;
