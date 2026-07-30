import type { Hex, OnChainProvider } from "../types.js";
import type { ChainProjectionEvent } from "./eventTypes.js";

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
  signature: Hex;
  nonceSalt: Hex;
}

export interface ReceiveAuthorizationVerification {
  signer: Hex;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Hex;
  };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: "ReceiveWithAuthorization";
  message: {
    from: Hex;
    to: Hex;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
  signature: Hex;
}

export interface SettlementResult {
  transactionHash: Hex;
  event: PaymentSettledEvent;
}

export interface PreparedFacilitatorTransaction {
  transactionHash: Hex;
  serializedTransaction: Hex;
  facilitatorNonce: bigint;
}

export interface PreparedSettlementTransaction
  extends PreparedFacilitatorTransaction {
  kind: "settle" | "settle_with_registration";
}

export type BroadcastObserver = (transactionHash: Hex) => Promise<void> | void;

export class SettlementTransactionRevertedError extends Error {
  constructor(transactionHash: Hex) {
    super(`settlement transaction reverted (${transactionHash})`);
    this.name = "SettlementTransactionRevertedError";
  }
}

// ── Atomic register-and-settle ───────────────────────────────────────────
//
// Combines the buyer's registration authorization with SettlementInput in
// a single transaction. If the buyer is already registered, the
// registration sub-call is skipped on-chain.
export interface SettleWithRegistrationInput extends SettlementInput {
  registration: {
    agentURI: string;
    deadline: bigint;
    signature: Hex;
  };
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

export interface PreparedConfirmationTransaction
  extends PreparedFacilitatorTransaction {}

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
  /** Exact per-(agent, client) index decoded from NewFeedback. */
  feedbackIndex?: bigint;
}

export interface PreparedFeedbackTransaction
  extends PreparedFacilitatorTransaction {}

export interface FeedbackRevocationInput {
  agentId: bigint;
  feedbackIndex: bigint;
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
  currentConfirmationUid: Hex;
  outcomeRecorded: boolean;
  reputationEligible: boolean;
}

export interface ProviderRegistryReader {
  getProviderCount(): Promise<bigint>;
  getProviderIdAt(index: bigint): Promise<bigint>;
  getProvider(agentId: bigint): Promise<{
    agentId: bigint;
    registrationTime: bigint;
    isActive: boolean;
  }>;
}

export interface ProviderAuthoritySnapshot {
  agentId: bigint;
  isActive: boolean;
  walletAddress: Hex;
  agentURI: string;
  registrationTime: bigint;
  observedBlock: bigint;
}

export interface IdentityReader {
  getAgentURI(agentId: bigint): Promise<string>;
  agentOfWallet(wallet: Hex): Promise<bigint>;
  getRegistrationNonce(wallet: Hex): Promise<bigint>;
  getAgentWallet(agentId: bigint): Promise<Hex>;
  getAgentOwner(agentId: bigint): Promise<Hex>;
}

export interface PaymentChainGateway {
  authorizationUsed(authorizer: Hex, nonce: Hex): Promise<boolean>;
  verifyReceiveAuthorization(
    input: ReceiveAuthorizationVerification,
  ): Promise<boolean>;
  prepareSettlement(
    input: SettlementInput,
    facilitatorNonce: bigint,
  ): Promise<PreparedSettlementTransaction>;
  prepareSettlementWithRegistration(
    input: SettleWithRegistrationInput,
    facilitatorNonce: bigint,
  ): Promise<PreparedSettlementTransaction>;
  submitPreparedSettlement(
    prepared: PreparedSettlementTransaction,
    expectedServiceRef: Hex,
    onBroadcast?: BroadcastObserver,
  ): Promise<SettlementResult & { registered?: boolean }>;
  findSettlementByTransaction(
    transactionHash: Hex,
    serviceRef: Hex,
  ): Promise<SettlementResult | null>;
  getFacilitatorTransactionCount(): Promise<bigint>;
  getFacilitatorPendingTransactionCount(): Promise<bigint>;
  getPaymentRecord(paymentId: bigint): Promise<PaymentRouterRecord | null>;
}

export interface ConfirmationRelayer {
  prepareBuyerConfirmation(
    input: ConfirmationDelegationInput,
    facilitatorNonce: bigint,
  ): Promise<PreparedConfirmationTransaction>;
  submitPreparedBuyerConfirmation(
    prepared: PreparedConfirmationTransaction,
    input: ConfirmationDelegationInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<ConfirmationResult>;
  getBuyerConfirmationByTransaction(
    transactionHash: Hex,
    input: ConfirmationDelegationInput,
  ): Promise<ConfirmationResult | null>;
  getEasAttesterNonce(attester: Hex): Promise<bigint>;
}

export interface ChainStatusReader {
  getBlockNumber(): Promise<bigint>;
  verifyDeploymentReadiness(): Promise<{
    ready: boolean;
    failedCheck: string | null;
  }>;
}

export interface ReputationReader {
  getProviderReputation(agentId: bigint): Promise<ProviderReputation | null>;
  getServiceReputation(serviceId: Hex): Promise<ServiceReputation | null>;
  getReputationRecord(paymentId: bigint): Promise<ReputationRecord | null>;
}

export interface ProviderDiscoveryReader extends ProviderRegistryReader {
  getBlockNumber(): Promise<bigint>;
  getAgentURI(agentId: bigint): Promise<string>;
  getAgentWallet(agentId: bigint): Promise<Hex>;
  getProviderAuthority(
    agentId: bigint,
    blockNumber: bigint,
  ): Promise<ProviderAuthoritySnapshot>;
}

export interface FeedbackWriter {
  prepareFeedback(
    input: FeedbackInput,
    facilitatorNonce: bigint,
  ): Promise<PreparedFeedbackTransaction>;
  submitPreparedFeedback(
    prepared: PreparedFeedbackTransaction,
    input: FeedbackInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<FeedbackResult>;
  getFeedbackByTransaction(
    transactionHash: Hex,
    input: FeedbackInput,
  ): Promise<FeedbackResult | null>;
  getFacilitatorTransactionCount(): Promise<bigint>;
  prepareFeedbackRevocation(
    input: FeedbackRevocationInput,
    facilitatorNonce: bigint,
  ): Promise<PreparedFeedbackTransaction>;
  submitPreparedFeedbackRevocation(
    prepared: PreparedFeedbackTransaction,
    input: FeedbackRevocationInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<FeedbackResult>;
  getFeedbackRevocationByTransaction(
    transactionHash: Hex,
    input: FeedbackRevocationInput,
  ): Promise<FeedbackResult | null>;
}

export interface ChainEventReader {
  getChainProjectionEvents(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<ChainProjectionEvent[]>;
}

// The composition root supplies one object implementing every capability;
// individual subsystems depend on the narrow interfaces above.
export interface ChainReader
  extends ProviderDiscoveryReader,
    IdentityReader,
    PaymentChainGateway,
    ConfirmationRelayer,
    ChainStatusReader,
    ReputationReader,
    FeedbackWriter,
    ChainEventReader {}

/**
 * Iterates the ProviderRegistry and returns active providers admitted by the
 * configured whitelist. An empty whitelist admits every active provider.
 * Resolves each provider's ERC-8004 agentURI from the Identity Registry so the
 * caller can fetch the registration file / Agent Card.
 */
export async function fetchOnChainProviders(
  reader: ProviderDiscoveryReader,
  whitelist: bigint[],
): Promise<OnChainProvider[]> {
  const observedBlock = await reader.getBlockNumber();
  const uniqueWhitelist = [
    ...new Map(
      whitelist.map((agentId) => [agentId.toString(), agentId]),
    ).values(),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const agentIds: bigint[] = [];
  if (uniqueWhitelist.length > 0) {
    agentIds.push(...uniqueWhitelist);
  } else {
    const count = await reader.getProviderCount();
    for (let index = 0n; index < count; index++) {
      agentIds.push(await reader.getProviderIdAt(index));
    }
  }
  const providers: OnChainProvider[] = [];

  for (const agentId of agentIds) {
    const authority = await reader.getProviderAuthority(
      agentId,
      observedBlock,
    );
    if (authority.isActive) providers.push(authority);
  }

  return providers.sort((left, right) =>
    left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0,
  );
}
