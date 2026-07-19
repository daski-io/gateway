import type { Hex, OnChainProvider } from "../types.js";

export interface PaymentSettledEvent {
  paymentId: bigint;
  serviceRef: Hex;
  // serviceId — 32-byte hex. PaymentRouter emits this as the third indexed
  // topic so subgraphs can cheaply filter per service.
  serviceId: Hex;
  buyerAgentId: bigint;
  providerAgentId: bigint;
  // Address of the ERC-20 used for this payment. Added when the router
  // became rail-agnostic — USDC is no longer the only accepted token.
  token: Hex;
  totalAmount: bigint;
  providerAmount: bigint;
  commission: bigint;
}

export interface SettlementInput {
  providerAgentId: bigint;
  // 32-byte hex serviceId. PaymentRouter.settle requires this — it
  // validates the (provider, service) pair against ServiceRegistry and
  // resolves the payee using the per-service wallet override (if set)
  // or the provider's live ERC-8004 agentWallet (default).
  serviceId: Hex;
  amount: bigint;
  serviceRef: Hex;
  from: Hex;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
}

export interface SettlementResult {
  transactionHash: Hex;
  event: PaymentSettledEvent;
}

export type BroadcastObserver = (
  transactionHash: Hex,
) => Promise<void> | void;

export class SettlementTransactionRevertedError extends Error {
  constructor(transactionHash: Hex) {
    super(`settlement transaction reverted (${transactionHash})`);
    this.name = "SettlementTransactionRevertedError";
  }
}

// ── External-rail attribution (DirectTransferAdapter) ────────────────────
//
// Used by the Bazaar-facing route after an EXTERNAL x402 facilitator (CDP)
// settled the buyer's EIP-3009 authorization as a bare transfer into the
// router. The gateway then submits DirectTransferAdapter.attribute to run
// the commission split + payment record for funds that already arrived.
// `authNonce` is the client-chosen EIP-3009 nonce — the adapter requires
// authorizationState(from, authNonce) == true as defense-in-depth.
export interface DirectAttributionInput {
  providerAgentId: bigint;
  serviceId: Hex;
  amount: bigint;
  serviceRef: Hex;
  from: Hex;
  authNonce: Hex;
}

// ── Gasless ERC-8004 registration ────────────────────────────────────────
//
// The buyer signs an EIP-712 RegisterAgent block over the Daski AgentIndex
// domain (name "Daski AgentIndex", verifyingContract = the AgentIndex
// proxy); the gateway facilitator relays it via AgentIndex.registerWithSig().
// The AgentIndex mints on the CANONICAL ERC-8004 registry and transfers the
// NFT to the signer — gateway pays gas. The signed payload binds (agentURI,
// agentWallet, nonce, deadline) so it cannot be replayed across re-registration.
export interface RegisterBySigInput {
  agentURI: string;
  agentWallet: Hex;
  deadline: bigint;
  signature: Hex;
}

export interface RegisterBySigResult {
  agentId: bigint;
  transactionHash: Hex;
}

// ── Atomic register-and-settle ───────────────────────────────────────────
//
// Combines RegisterBySigInput with SettlementInput in a single tx via
// X402Adapter.settleWithRegistration. If the buyer is already registered,
// the registration sub-call is skipped on-chain and the registration
// signature is ignored.
export interface SettleWithRegistrationInput extends SettlementInput {
  registration: {
    agentURI: string;
    deadline: bigint;
    signature: Hex;
  };
}

export interface SettleWithRegistrationResult extends SettlementResult {
  buyerAgentId: bigint;
  /** True when the on-chain path actually minted a new agent in this tx. */
  registered: boolean;
}

// ── Buyer confirmation via EAS.attestByDelegation ────────────────────────
//
// Gateway acts as the relayer: the buyer signs an ATTEST delegation payload
// off-chain and hands it to the gateway, which submits it on-chain so the
// buyer pays no gas. The resulting attestation is what the
// ReputationStorage resolver's onAttest() callback uses to update counters.
export interface ConfirmationDelegationInput {
  attester: Hex;
  schema: Hex;
  recipient: Hex;
  expirationTime: bigint;
  revocable: boolean;
  refUID: Hex;
  data: Hex;
  value: bigint;
  deadline: bigint;
  signature: {
    v: number;
    r: Hex;
    s: Hex;
  };
}

export interface ConfirmationResult {
  transactionHash: Hex;
  attestationUid: Hex;
}

// ── Canonical ERC-8004 ReputationRegistry feedback ───────────────────────
//
// The gateway's facilitator wallet acts as the orchestrator-client the
// ERC-8004 spec allows: after a buyer confirmation lands on EAS, it mirrors
// the result as public feedback on the canonical per-chain
// ReputationRegistry (0x8004B…). Field semantics follow the pinned spec:
// value is int128 scaled by 10^-valueDecimals; tag1/tag2 are free-form
// filter strings; feedbackURI/feedbackHash bind the entry to off-chain
// evidence.
export interface FeedbackInput {
  /** Provider agentId on the canonical IdentityRegistry. */
  agentId: bigint;
  /** int128 — may be negative per spec, Daski uses 0..100. */
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
}

export interface FeedbackResult {
  transactionHash: Hex;
}

// ── PaymentRouter.getPayment record ──────────────────────────────────────
//
// On-chain PaymentRecord for a settled paymentId — the authoritative
// (buyer, provider, service) tuple. The reader returns null for unknown
// paymentIds. Agent ID zero is valid and must never be used as a sentinel.
export interface PaymentRouterRecord {
  buyerAgentId: bigint;
  providerAgentId: bigint;
  serviceId: Hex;
  token: Hex;
  amount: bigint;
  cachedBuyerWallet: Hex;
  cachedProviderOwner: Hex;
  cachedProviderWallet: Hex;
  serviceRef: Hex;
  paidAt: bigint;
  reputationEligible: boolean;
}

// ── ReputationStorage views ──────────────────────────────────────────────
//
// Mirrors the (completed, failed, canceled, confirmed, notConfirmed) and
// (transactions, confirmed, notConfirmed) tuples returned by
// ReputationStorage. Counters are bigints because the contract returns
// uint256 — it's vanishingly unlikely they'd ever exceed Number.MAX_SAFE,
// but keeping the type honest at the boundary lets the formatter decide.
export interface ProviderReputation {
  completed: bigint;
  failed: bigint;
  canceled: bigint;
  confirmed: bigint;
  notConfirmed: bigint;
}

export interface BuyerReputation {
  transactions: bigint;
  confirmed: bigint;
  notConfirmed: bigint;
}

// Per-service reputation tuple — same outcome counters as
// ProviderReputation plus a totalRefunded (atomic USDC). Returned by
// ReputationStorage.getServiceStats.
export interface ServiceReputation {
  completed: bigint;
  failed: bigint;
  canceled: bigint;
  confirmed: bigint;
  notConfirmed: bigint;
  totalRefunded: bigint;
}

// Solidity-mirror string labels for the two enums attached to a reputation
// record. The contract stores them as uint8s; this layer maps to strings so
// downstream JSON consumers don't depend on the enum ordinal.
export type TransactionOutcome = "Completed" | "Failed" | "Canceled";
export type BuyerConfirmationLabel = "Pending" | "Confirmed" | "NotConfirmed";

// Per-paymentId record from ReputationStorage.getRecord. The on-chain struct
// is a zero-init default for unknown paymentIds; the gateway converts that
// case to `null` at the reader boundary so callers see "no record" cleanly.
//
// `fulfillmentSeconds` is the wall-clock turnaround derived ON-CHAIN as
// `block.timestamp - PaymentRouter.PaymentRecord.paidAt` at the moment the
// provider's outcome attestation lands. It is gameless — the provider's
// self-reported number is ignored in favor of block timestamps. Null until
// `outcomeRecorded` is true.
export interface ReputationRecord {
  paymentId: bigint;
  providerAgentId: bigint;
  buyerAgentId: bigint;
  serviceId: Hex;
  /** Null until the provider attests an outcome. */
  outcome: TransactionOutcome | null;
  /** Always present; "Pending" = no buyer confirmation yet. */
  confirmation: BuyerConfirmationLabel;
  /** Seconds between paidAt and the outcome attestation. Null until outcomeRecorded. */
  fulfillmentSeconds: bigint | null;
  /** Block-timestamp seconds of the outcome attestation; 0 until recorded. */
  outcomeTimestamp: bigint;
  /** Block-timestamp seconds of the latest confirmation; 0 until attested. */
  confirmationTimestamp: bigint;
  outcomeRecorded: boolean;
  reputationEligible: boolean;
}

// Wraps every chain read AND write the gateway performs. Tests inject a
// fake implementation; prod uses the viem-backed one in viemReader.ts.
export interface ChainReader {
  // ProviderRegistry reads
  getProviderCount(): Promise<bigint>;
  getProviderIdAt(index: bigint): Promise<bigint>;
  getProvider(agentId: bigint): Promise<{
    agentId: bigint;
    registrationTime: bigint;
    isActive: boolean;
  }>;

  // IdentityRegistry / AgentIndex reads
  /** Returns the agentURI stored at the canonical IdentityRegistry's
   *  tokenURI(agentId). */
  getAgentURI(agentId: bigint): Promise<string>;

  /**
   * Reverse lookup: maps an EVM wallet back to the ERC-8004 agentId it
   * controls. Resolves via the Daski AgentIndex (verified against the
   * canonical registry; stale bindings return 0). Returns 0 when the
   * wallet has no bound identity (the skill surfaces this as "you need to
   * mint a Daski identity first"). Used by GET /identity/by-wallet to
   * resolve buyer agentId from a CDP-issued address.
   */
  agentOfWallet(wallet: Hex): Promise<bigint>;

  // Pre-flight: skip settlement if the authorization's nonce has already
  // been consumed on-chain (USDC rejects duplicates anyway, but a read
  // is cheaper than a reverted write).
  authorizationUsed(authorizer: Hex, nonce: Hex): Promise<boolean>;

  // Per-wallet registerWithSig nonce, read from AgentIndex.registrationNonce.
  // Buyer reads this and embeds it into the EIP-712 RegisterAgent
  // typed-data; gateway uses it the same way to build the typed-data block
  // returned by /register-prep.
  getRegistrationNonce(wallet: Hex): Promise<bigint>;

  // Settlement — submits X402Adapter.settle from the facilitator wallet,
  // waits for a confirmation, and returns the decoded PaymentSettled event
  // (emitted by the PaymentRouter, not the adapter). Throws if the
  // transaction reverts or no matching event is emitted.
  settlePayment(
    input: SettlementInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<SettlementResult>;

  // Gasless registration — submits AgentIndex.registerWithSig from the
  // facilitator wallet. The AgentIndex mints on the canonical registry and
  // transfers the NFT to input.agentWallet, not the relayer. Returns the
  // new agentId from the AgentRegistered event in the receipt.
  registerBuyer(input: RegisterBySigInput): Promise<RegisterBySigResult>;

  // Atomic register-and-settle. Submits X402Adapter.settleWithRegistration
  // so registration + EIP-3009 transfer + router.settle all live in one
  // tx — either every step succeeds or none do, which is what makes the
  // USDC payment the Sybil tax for fresh-wallet registrations.
  settleWithRegistration(
    input: SettleWithRegistrationInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<SettleWithRegistrationResult>;

  // External-rail attribution — submits DirectTransferAdapter.attribute
  // from the facilitator wallet AFTER an external facilitator's settle
  // moved the funds. Returns the decoded PaymentSettled event (emitted by
  // the router). Throws when DIRECT_ADAPTER_ADDRESS is unconfigured, the
  // tx reverts, or no matching event is found.
  attributeDirectTransfer(
    input: DirectAttributionInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<SettlementResult>;

  // Resume a previously broadcast settlement or attribution transaction.
  // Waits for its receipt and returns the matching router event.
  getSettlementByTransaction(
    transactionHash: Hex,
    serviceRef: Hex,
  ): Promise<SettlementResult>;

  // Confirmation submission — submits EAS.attestByDelegation on the buyer's
  // behalf so they pay no gas. The reader does not verify the delegation
  // signature itself (EAS does); it only forwards the signed payload. The
  // returned UID is parsed out of the EAS Attested event.
  submitBuyerConfirmation(
    input: ConfirmationDelegationInput,
  ): Promise<ConfirmationResult>;

  // Return the on-chain nonce EAS expects for the next delegated
  // attestation from this attester. Buyers need this value when signing
  // the ATTEST typed-data payload.
  getEasAttesterNonce(attester: Hex): Promise<bigint>;

  // Latest known L1 block number. Surfaced by the public /stats endpoint
  // so the marketing site can show a live "block height" indicator without
  // needing its own RPC wiring.
  getBlockNumber(): Promise<bigint>;

  // ── ReputationStorage views ────────────────────────────────────────────
  // Both return null when the gateway is configured without a
  // ReputationStorage address (e.g. local dev). When the contract is wired
  // but the agent has no recorded activity, the counters are all zero —
  // which is a meaningful "no transaction history yet" signal, not an
  // error. Callers should distinguish null (not configured) from all-zero
  // (configured but inactive).
  getProviderReputation(agentId: bigint): Promise<ProviderReputation | null>;
  getBuyerReputation(agentId: bigint): Promise<BuyerReputation | null>;
  // Per-service stats. Same null-when-unconfigured contract as the
  // provider/buyer getters. The all-zero return is "valid service, no
  // recorded activity yet" — distinct from null (gateway has no
  // ReputationStorage configured).
  getServiceReputation(serviceId: Hex): Promise<ServiceReputation | null>;

  // Per-paymentId reputation record. Two flavors of null:
  //   - ReputationStorage not configured (returns null without an RPC call).
  //   - Record absent: the contract returns a zero-init struct for an
  //     unknown paymentId; the reader detects `paymentId == 0` and returns
  //     null so the caller doesn't have to disambiguate.
  // Use the `fulfillmentSeconds` / `outcome` fields to surface wall-clock
  // turnaround and provider-attested status on activity rows.
  getReputationRecord(paymentId: bigint): Promise<ReputationRecord | null>;

  // Canonical live agentWallet from the canonical IdentityRegistry.
  // PaymentRouter resolves payees through this same getter; the audit
  // refactor removed ProviderRegistry's `walletAddress` field, making this
  // the sole source of a provider's payee wallet. Returns address(0) when
  // the agent has no wallet set — callers treat that as "no payee
  // currently". NOTE: the canonical registry never auto-sets agentWallet,
  // so buyer agents minted via AgentIndex.registerWithSig read as
  // address(0) here; callers must tolerate 0 for buyers.
  getAgentWallet(agentId: bigint): Promise<Hex>;

  // Canonical ERC-721 owner. Buyer control accepts either this address or
  // getAgentWallet(agentId), matching PaymentRouter's authorization rule.
  getAgentOwner(agentId: bigint): Promise<Hex>;

  // Cumulative refunded amount (atomic USDC) for one paymentId from
  // PaymentRouter.refundedAmount. Returns 0n for both unknown and
  // settled-but-unrefunded payments — the gateway disambiguates against
  // its own challenge row.
  getPaymentRefundedAmount(paymentId: bigint): Promise<bigint>;

  // Full on-chain PaymentRecord from PaymentRouter.getPayment. Null for
  // unknown paymentIds. The reputation mirror uses this as the authoritative
  // provider and eligibility lookup.
  getPaymentRecord(paymentId: bigint): Promise<PaymentRouterRecord | null>;

  // ── Canonical ERC-8004 ReputationRegistry (feedback mirror) ────────────
  // All three throw when REPUTATION_REGISTRY_ADDRESS is unconfigured — the
  // mirror module gates on config before calling, so an unconfigured
  // gateway never reaches these.

  // Post public feedback from the facilitator wallet (the ERC-8004
  // "client"). Reverts on-chain if the facilitator is the agent's
  // owner/operator/approved/agentWallet (spec arms-length rule).
  giveFeedback(input: FeedbackInput): Promise<FeedbackResult>;

  // Soft-revoke one of the facilitator's own feedback entries. Reverts
  // with "no such feedback" / "already revoked" — revision flows call this
  // best-effort and swallow those.
  revokeFeedback(agentId: bigint, feedbackIndex: bigint): Promise<FeedbackResult>;

  // Last (1-based) feedback index THE FACILITATOR WALLET has posted for
  // this agent on the canonical ReputationRegistry; 0n = none yet. The
  // clientAddress is implicitly the reader's own facilitator account —
  // the only client identity the gateway writes feedback under.
  getFeedbackLastIndex(agentId: bigint): Promise<bigint>;

  /**
   * Pull `PaymentRouter.PaymentSettled` event logs in a block range. Used
   * by the chain-events indexer to mirror on-chain settlements into the
   * gateway DB so /activity reflects all transactions, not just the ones
   * this gateway issued. Block range inclusive on both ends.
   *
   * Returns the decoded event payloads plus per-log positional fields
   * (blockNumber, transactionHash, blockTimestamp) so the indexer can
   * upsert directly without re-fetching per-tx context.
   */
  getPaymentSettledEvents(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Array<PaymentSettledEventLog>>;
}

/**
 * One decoded `PaymentSettled` event with the chain-context fields the
 * indexer needs to persist its row. `blockTimestamp` is the block's
 * timestamp (seconds since epoch); callers convert to a Date.
 */
export interface PaymentSettledEventLog extends PaymentSettledEvent {
  blockNumber: bigint;
  blockTimestamp: bigint;
  transactionHash: Hex;
}

/**
 * Iterates the ProviderRegistry and returns whitelisted, active providers.
 * Resolves each provider's ERC-8004 agentURI from the Identity Registry so
 * the caller can fetch the registration file / Agent Card.
 */
export async function fetchOnChainProviders(
  reader: ChainReader,
  whitelist: bigint[],
): Promise<OnChainProvider[]> {
  const count = await reader.getProviderCount();
  const whitelistSet = new Set(whitelist.map((x) => x.toString()));
  const providers: OnChainProvider[] = [];

  for (let i = 0n; i < count; i++) {
    const agentId = await reader.getProviderIdAt(i);
    const provider = await reader.getProvider(agentId);

    if (!provider.isActive) continue;
    if (!whitelistSet.has(agentId.toString())) continue;

    // Read the canonical wallet from the canonical IdentityRegistry. The
    // audit refactor dropped ProviderRegistry's `walletAddress` field
    // entirely, so IdentityRegistry.getAgentWallet is the sole source — it
    // is also what PaymentRouter resolves payees through, so discovery
    // always reflects the live payee even across ERC-8004 wallet rotation.
    // The canonical registry never auto-sets agentWallet (providers must
    // call setAgentWallet explicitly); when unset, getAgentWallet returns
    // the zero address and we surface that as-is (there is no longer a
    // registry hint to fall back to) so callers can treat it as "no payee
    // currently".
    const [agentURI, liveWallet] = await Promise.all([
      reader.getAgentURI(agentId),
      reader.getAgentWallet(agentId),
    ]);

    providers.push({
      agentId,
      walletAddress: liveWallet,
      agentURI,
      registrationTime: provider.registrationTime,
      isActive: true,
      isWhitelisted: true,
    });
  }

  return providers;
}
