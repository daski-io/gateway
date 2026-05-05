// Contract ABI fragments — single source of truth for the gateway.
// Mirrors the on-chain contracts in the `daski` repo.

// ── ERC-8004 Identity Registry ──────────────────────────────────────────

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
    type: "function",
    name: "getAgentWallet",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
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
  {
    type: "function",
    name: "isRegistered",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

// ── Daski PaymentRouter ─────────────────────────────────────────────────
//
// The router is now rail-agnostic — adapters handle the specifics of how
// funds arrive. The gateway consumes PaymentSettled (emitted by the router)
// and the Refunded event.

export const paymentRouterAbi = [
  {
    type: "event",
    name: "PaymentSettled",
    inputs: [
      { name: "paymentId", type: "uint256", indexed: true },
      { name: "serviceRef", type: "bytes32", indexed: true },
      { name: "buyerAgentId", type: "uint256", indexed: false },
      { name: "providerAgentId", type: "uint256", indexed: false },
      { name: "token", type: "address", indexed: false },
      { name: "totalAmount", type: "uint256", indexed: false },
      { name: "providerAmount", type: "uint256", indexed: false },
      { name: "commission", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "paymentId", type: "uint256", indexed: true },
      { name: "amountToBuyer", type: "uint256", indexed: false },
      { name: "cumulativeRefunded", type: "uint256", indexed: false },
    ],
  },
  {
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
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "cachedBuyerWallet", type: "address" },
          { name: "serviceRef", type: "bytes32" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refundedAmount",
    inputs: [{ name: "paymentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isAdapter",
    inputs: [{ name: "adapter", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isAcceptedToken",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
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

// ── PermitAdapter (EIP-2612) — informational; gateway does not submit ──

export const permitAdapterAbi = [
  {
    type: "function",
    name: "settle",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "serviceRef", type: "bytes32" },
      { name: "providerAgentId", type: "uint256" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "value", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

// ── ApprovalAdapter — informational ────────────────────────────────────

export const approvalAdapterAbi = [
  {
    type: "function",
    name: "settle",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "serviceRef", type: "bytes32" },
      { name: "providerAgentId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

// ── EAS (subset the gateway uses) ───────────────────────────────────────
//
// The gateway acts as the relayer for buyer confirmations: it receives a
// signed AttestByDelegation payload from the buyer and submits it via
// EAS.attestByDelegation so the buyer never pays gas. It also reads back
// the attestation to return the resulting UID to the caller.
//
// Schema registry subset (attestations land on-chain by schema UID; the UID
// was registered once against the Daski ReputationStorage resolver at
// deployment time and is passed through as env config).

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
    // Needed for building a proper ATTEST typed-data signature on the buyer
    // side. Gateway does not call this — we pass it through so the helper
    // in daski-test can read it.
    type: "function",
    name: "getDomainSeparator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "getAttestation",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "refUID", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
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
