import type { Hex, OnChainProvider } from "../types.js";

export interface ChainLog {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
  logIndex?: number;
}

export interface ChainTransactionReceipt {
  transactionHash: Hex;
  status: "success" | "reverted";
  to: Hex | null;
  logs: ChainLog[];
}

export interface PaymentSettledEvent {
  paymentId: bigint;
  serviceRef: Hex;
  // serviceId — 32-byte hex. The post-refactor router (PaymentRouter v2)
  // emits this as the third indexed topic so subgraphs can cheap-filter
  // per-service. Always set on new settlements; legacy events read as
  // bytes32(0).
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

// ── Gasless ERC-8004 registration ────────────────────────────────────────
//
// The buyer signs an EIP-712 RegisterAgent block over the IdentityRegistry
// domain; the gateway facilitator relays it via registerBySig(). NFT mints
// to the signer, gateway pays gas. The signed payload binds (agentURI,
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
}

// Wraps every chain read AND write the gateway performs. Tests inject a
// fake implementation; prod uses the viem-backed one in viemReader.ts.
export interface ChainReader {
  // ProviderRegistry reads
  getProviderCount(): Promise<bigint>;
  getProviderIdAt(index: bigint): Promise<bigint>;
  getProvider(agentId: bigint): Promise<{
    walletAddress: Hex;
    agentId: bigint;
    registrationTime: bigint;
    isActive: boolean;
  }>;

  // IdentityRegistry reads
  /** Returns the agentURI stored at IdentityRegistry.tokenURI(agentId). */
  getAgentURI(agentId: bigint): Promise<string>;

  /**
   * Reverse lookup: maps an EVM wallet back to the ERC-8004 agentId it
   * controls on IdentityRegistry. Returns 0 when the wallet has no minted
   * identity (the skill surfaces this as "you need to mint a Daski identity
   * first"). Used by GET /identity/by-wallet to resolve buyer agentId from
   * a CDP-issued address.
   */
  agentOfWallet(wallet: Hex): Promise<bigint>;

  // Pre-flight: skip settlement if the authorization's nonce has already
  // been consumed on-chain (USDC rejects duplicates anyway, but a read
  // is cheaper than a reverted write).
  authorizationUsed(authorizer: Hex, nonce: Hex): Promise<boolean>;

  // Per-wallet RegisterBySig nonce. Buyer reads this and embeds it into
  // the EIP-712 RegisterAgent typed-data; gateway uses it the same way to
  // build the typed-data block returned by /register-prep.
  getRegistrationNonce(wallet: Hex): Promise<bigint>;

  // Settlement — submits X402Adapter.settle from the facilitator wallet,
  // waits for a confirmation, and returns the decoded PaymentSettled event
  // (emitted by the PaymentRouter, not the adapter). Throws if the
  // transaction reverts or no matching event is emitted.
  settlePayment(input: SettlementInput): Promise<SettlementResult>;

  // Gasless registration — submits IdentityRegistry.registerBySig from the
  // facilitator wallet. NFT mints to input.agentWallet, not the relayer.
  // Returns the new agentId from the Registered event in the receipt.
  registerBuyer(input: RegisterBySigInput): Promise<RegisterBySigResult>;

  // Atomic register-and-settle. Submits X402Adapter.settleWithRegistration
  // so registration + EIP-3009 transfer + router.settle all live in one
  // tx — either every step succeeds or none do, which is what makes the
  // USDC payment the Sybil tax for fresh-wallet registrations.
  settleWithRegistration(
    input: SettleWithRegistrationInput,
  ): Promise<SettleWithRegistrationResult>;

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

  // Canonical live agentWallet from IdentityRegistry. PaymentRouter resolves
  // payees through this same getter, and ProviderRegistry's `walletAddress`
  // field is explicitly deprecated in favor of it (see ProviderRegistry.sol
  // around updateWalletAddress). Returns address(0) when the agent has unset
  // their wallet — callers should fall back to the ProviderRegistry hint
  // when that happens (or treat it as "no payee currently").
  getAgentWallet(agentId: bigint): Promise<Hex>;

  // Cumulative refunded amount (atomic USDC) for one paymentId from
  // PaymentRouter.refundedAmount. Returns 0n for both unknown and
  // settled-but-unrefunded payments — the gateway disambiguates against
  // its own challenge row.
  getPaymentRefundedAmount(paymentId: bigint): Promise<bigint>;

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

    // Read the canonical wallet from IdentityRegistry instead of trusting
    // ProviderRegistry's deprecated `walletAddress` hint — PaymentRouter
    // resolves payees through the IdentityRegistry getter, so a wallet
    // rotation that hasn't been mirrored back into ProviderRegistry would
    // otherwise leave discovery showing the old address while settlements
    // correctly went to the new one. If IdentityRegistry returns the zero
    // address (agent has unset their wallet), fall back to the registry
    // hint rather than emitting 0x0 — `agentWallet` can lag genuine
    // intent during a transfer window.
    const [agentURI, liveWallet] = await Promise.all([
      reader.getAgentURI(agentId),
      reader.getAgentWallet(agentId),
    ]);
    const ZERO_ADDR = ("0x" + "00".repeat(20)) as Hex;
    const walletAddress =
      liveWallet === ZERO_ADDR ? provider.walletAddress : liveWallet;

    providers.push({
      agentId,
      walletAddress,
      agentURI,
      registrationTime: provider.registrationTime,
      isActive: true,
      isWhitelisted: true,
    });
  }

  return providers;
}
