// Contract ABI fragments — single source of truth for the gateway.
// Mirrors the on-chain contracts in the `daski` repo.

// ── ERC-8004 Identity Registry ──────────────────────────────────────────

export const identityRegistryAbi = [
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    // Daski auxiliary reverse index — wallet → agentId (0 if unmapped).
    type: "function",
    name: "agentOfWallet",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    // Per-wallet nonce for registerBySig. Buyer reads this when building
    // the EIP-712 RegisterAgent typed-data; bumps each successful relay.
    type: "function",
    name: "registrationNonce",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    // Gasless registration: the buyer signs an EIP-712 RegisterAgent struct
    // off-chain, the gateway facilitator submits it. NFT mints to the
    // signer (`agentWallet`), not the relayer (msg.sender).
    type: "function",
    name: "registerBySig",
    inputs: [
      { name: "agentURI", type: "string" },
      { name: "agentWallet", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
    stateMutability: "nonpayable",
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
          { name: "walletAddress", type: "address" },
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

// ── Daski ServiceRegistry ───────────────────────────────────────────────
//
// Per-provider service catalog introduced in the service-identity refactor.
// `serviceId = keccak256(abi.encodePacked(uint256 providerAgentId, string skillId, string version))`
// — matches the contract's `_computeServiceId`. Gateway computes it
// off-chain (cheap, deterministic) and PaymentRouter.settle validates that
// the service belongs to providerAgentId and is active.
export const serviceRegistryAbi = [
  {
    type: "function",
    name: "getService",
    inputs: [{ name: "serviceId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "providerAgentId", type: "uint256" },
          { name: "serviceId", type: "bytes32" },
          { name: "skillId", type: "string" },
          { name: "version", type: "string" },
          { name: "serviceURI", type: "string" },
          { name: "serviceWallet", type: "address" },
          { name: "createdAt", type: "uint64" },
          { name: "active", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isActive",
    inputs: [{ name: "serviceId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "exists",
    inputs: [{ name: "serviceId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "computeServiceId",
    inputs: [
      { name: "providerAgentId", type: "uint256" },
      { name: "skillId", type: "string" },
      { name: "version", type: "string" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "pure",
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
    ],
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
      // serviceId binds the payment to a specific row in ServiceRegistry.
      // The buyer's EIP-3009 nonce MUST be
      // `keccak256(abi.encode(serviceRef, providerAgentId, serviceId))`
      // so a frontrunner cannot redirect the auth to a different service.
      { name: "serviceId", type: "bytes32" },
      {
        name: "auth",
        type: "tuple",
        components: [
          { name: "from", type: "address" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    // Atomic register-and-settle. If `auth.from` has no agentId, the
    // buyer's RegisterAgent signature mints one in the same tx as the
    // EIP-3009 transfer. Either both succeed or both revert. Used by the
    // gateway when a fresh wallet's first action is a purchase.
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
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
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
  // OpenZeppelin ERC721 v5 — IdentityRegistry mints via _safeMint, so the
  // receiver/sender errors are reachable through registerBySig.
  { type: "error", name: "ERC721InvalidOwner", inputs: [{ name: "owner", type: "address" }] },
  { type: "error", name: "ERC721NonexistentToken", inputs: [{ name: "tokenId", type: "uint256" }] },
  {
    type: "error",
    name: "ERC721IncorrectOwner",
    inputs: [
      { name: "sender", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "owner", type: "address" },
    ],
  },
  { type: "error", name: "ERC721InvalidSender", inputs: [{ name: "sender", type: "address" }] },
  { type: "error", name: "ERC721InvalidReceiver", inputs: [{ name: "receiver", type: "address" }] },
  {
    type: "error",
    name: "ERC721InsufficientApproval",
    inputs: [
      { name: "operator", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
  },
  { type: "error", name: "ERC721InvalidApprover", inputs: [{ name: "approver", type: "address" }] },
  { type: "error", name: "ERC721InvalidOperator", inputs: [{ name: "operator", type: "address" }] },

  // OpenZeppelin Initializable — UUPS proxies behind every Daski contract.
  { type: "error", name: "InvalidInitialization", inputs: [] },
  { type: "error", name: "NotInitializing", inputs: [] },

  // OpenZeppelin ECDSA — SignatureChecker uses ECDSA.tryRecover internally.
  // SignatureChecker itself swallows these and returns false (causing a
  // require-string revert in registerBySig), but raw ECDSA.recover is also
  // used in places, and these errors travel up unwrapped.
  { type: "error", name: "ECDSAInvalidSignature", inputs: [] },
  {
    type: "error",
    name: "ECDSAInvalidSignatureLength",
    inputs: [{ name: "length", type: "uint256" }],
  },
  { type: "error", name: "ECDSAInvalidSignatureS", inputs: [{ name: "s", type: "bytes32" }] },

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
