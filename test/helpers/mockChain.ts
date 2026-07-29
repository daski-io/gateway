import type { ChainProjectionEvent } from "../../src/chain/eventTypes.js";
import { recoverTypedDataAddress } from "viem";
import { FeedbackSubmissionError } from "../../src/chain/feedbackErrors.js";
import {
  ConfirmationSubmitError,
  type ConfirmationFailureStage,
} from "../../src/chain/confirmationErrors.js";

export type ConfirmationOutcome =
  | { kind: "success"; txHash: `0x${string}`; attestationUid: `0x${string}` }
  | { kind: "revert"; reason: string }
  | {
      kind: "stage";
      stage: ConfirmationFailureStage;
      reason: string;
      txHash?: `0x${string}`;
      needsFreshSignature?: boolean;
    };
import type {
  ChainReader,
  ConfirmationDelegationInput,
  ConfirmationResult,
  FeedbackInput,
  FeedbackResult,
  PreparedFeedbackTransaction,
  ReceiveAuthorizationVerification,
  PaymentRouterRecord,
  PaymentSettledEvent,
  ProviderReputation,
  ReputationRecord,
  ServiceReputation,
  SettleWithRegistrationInput,
  SettleWithRegistrationResult,
  SettlementInput,
  SettlementResult,
  BroadcastObserver,
} from "../../src/chain/reader.js";
import type { Hex } from "../../src/types.js";
import {
  SettlementScreeningError,
  type ScreeningDetectionSource,
  type SettlementScreeningFailure,
} from "../../src/chain/sanctionsErrors.js";

interface MockProviderEntry {
  walletAddress: Hex;
  agentId: bigint;
  registrationTime: bigint;
  isActive: boolean;
}

interface QueuedRegistrationInput {
  agentURI: string;
  agentWallet: Hex;
  deadline: bigint;
  signature: Hex;
}

export type SettlementOutcome =
  | { kind: "success"; event: PaymentSettledEvent; txHash: Hex }
  | {
      kind: "broadcast-error";
      event: PaymentSettledEvent;
      txHash: Hex;
      reason: string;
    }
  | {
      kind: "screening-error";
      failure: SettlementScreeningFailure;
      detectionSource: ScreeningDetectionSource;
      transactionHash?: Hex | null;
    }
  | { kind: "revert"; reason: string };

/**
 * In-memory ChainReader. Tests feed it provider data, nonce state, and a
 * scripted sequence of settlement outcomes.
 */
export class MockChainReader implements ChainReader {
  private sanctionsReady = true;
  private providers = new Map<string, MockProviderEntry>();
  private providerOrder: bigint[] = [];
  // agentURI stored separately to mirror the IdentityRegistry lookup.
  private agentURIs = new Map<string, string>();
  private authStates = new Map<string, boolean>();
  private outcomes: SettlementOutcome[] = [];
  private settlementResults = new Map<string, SettlementResult>();
  private settlementRecoveryErrors = new Map<string, Error>();

  public settlements: SettlementInput[] = [];
  public simulations: SettlementInput[] = [];

  addProvider(agentId: bigint, entry: MockProviderEntry & { agentURI: string }): void {
    const key = agentId.toString();
    if (!this.providers.has(key)) this.providerOrder.push(agentId);
    this.providers.set(key, {
      walletAddress: entry.walletAddress,
      agentId: entry.agentId,
      registrationTime: entry.registrationTime,
      isActive: entry.isActive,
    });
    this.agentURIs.set(key, entry.agentURI);
  }

  setAuthorizationUsed(authorizer: Hex, nonce: Hex, used: boolean): void {
    this.authStates.set(`${authorizer.toLowerCase()}:${nonce.toLowerCase()}`, used);
  }

  /** Queue the next settlement outcome. Tests call this before every submit. */
  queueSettlement(outcome: SettlementOutcome): void {
    this.outcomes.push(outcome);
  }

  setSettlementRecoveryError(transactionHash: Hex, error: Error): void {
    this.settlementRecoveryErrors.set(transactionHash.toLowerCase(), error);
  }

  // ── ChainReader implementation ──────────────────────────────

  async getProviderCount(): Promise<bigint> {
    return BigInt(this.providerOrder.length);
  }

  async getProviderIdAt(index: bigint): Promise<bigint> {
    const i = Number(index);
    const id = this.providerOrder[i];
    if (id === undefined) throw new Error(`providerIds index ${i} out of range`);
    return id;
  }

  async getProvider(agentId: bigint): Promise<MockProviderEntry> {
    const entry = this.providers.get(agentId.toString());
    return (
      entry ?? {
        walletAddress: `0x${"00".repeat(20)}` as Hex,
        agentId,
        registrationTime: 0n,
        isActive: false,
      }
    );
  }

  async getAgentURI(agentId: bigint): Promise<string> {
    const uri = this.agentURIs.get(agentId.toString());
    if (uri === undefined) throw new Error(`agentURI for ${agentId} not found`);
    return uri;
  }

  // Buyer-side tokenURIs aren't tied to a provider entry — used by the
  // public-route buyer-name resolver. addProvider also populates
  // `agentURIs`; this setter is for buyer-only IDs that don't appear in
  // the provider list.
  setAgentURI(agentId: bigint, uri: string): void {
    this.agentURIs.set(agentId.toString(), uri);
  }

  // Reverse-index — mirrors AgentIndex.resolve. Tests that care about
  // identity lookups call setAgentOfWallet; default is 0n (= unregistered).
  private walletToAgent = new Map<string, bigint>();

  setAgentOfWallet(wallet: Hex, agentId: bigint): void {
    this.walletToAgent.set(wallet.toLowerCase(), agentId);
  }

  async agentOfWallet(wallet: Hex): Promise<bigint> {
    return this.walletToAgent.get(wallet.toLowerCase()) ?? 0n;
  }

  // Live agentWallet override. Tests that exercise wallet rotation set this
  // explicitly; otherwise the mock falls back to the registered provider's
  // walletAddress so existing tests don't have to know about the new
  // IdentityRegistry-driven path.
  private agentWalletOverrides = new Map<string, Hex>();
  private agentOwnerOverrides = new Map<string, Hex>();

  setAgentWallet(agentId: bigint, wallet: Hex): void {
    this.agentWalletOverrides.set(agentId.toString(), wallet.toLowerCase() as Hex);
  }

  setAgentOwner(agentId: bigint, wallet: Hex): void {
    this.agentOwnerOverrides.set(agentId.toString(), wallet.toLowerCase() as Hex);
  }

  async getAgentWallet(agentId: bigint): Promise<Hex> {
    const override = this.agentWalletOverrides.get(agentId.toString());
    if (override) return override;
    const provider = this.providers.get(agentId.toString());
    return provider
      ? (provider.walletAddress.toLowerCase() as Hex)
      : (("0x" + "00".repeat(20)) as Hex);
  }

  async getAgentOwner(agentId: bigint): Promise<Hex> {
    const override = this.agentOwnerOverrides.get(agentId.toString());
    if (override) return override;
    for (const [wallet, mappedAgentId] of this.walletToAgent) {
      if (mappedAgentId === agentId) return wallet as Hex;
    }
    const provider = this.providers.get(agentId.toString());
    return provider
      ? (provider.walletAddress.toLowerCase() as Hex)
      : (("0x" + "00".repeat(20)) as Hex);
  }

  async authorizationUsed(authorizer: Hex, nonce: Hex): Promise<boolean> {
    return (
      this.authStates.get(
        `${authorizer.toLowerCase()}:${nonce.toLowerCase()}`,
      ) ?? false
    );
  }

  async verifyReceiveAuthorization(
    input: ReceiveAuthorizationVerification,
  ): Promise<boolean> {
    const recovered = await recoverTypedDataAddress({
      domain: input.domain,
      types: input.types,
      primaryType: input.primaryType,
      message: input.message,
      signature: input.signature,
    });
    return recovered.toLowerCase() === input.signer.toLowerCase();
  }

  async simulatePayment(input: SettlementInput): Promise<void> {
    this.simulations.push(input);
  }

  async settlePayment(
    input: SettlementInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<SettlementResult> {
    this.settlements.push(input);
    const outcome = this.outcomes.shift();
    if (!outcome) {
      throw new Error(
        "MockChainReader.settlePayment called with no queued outcome",
      );
    }
    if (outcome.kind === "revert") throw new Error(outcome.reason);
    if (outcome.kind === "screening-error") {
      throw new SettlementScreeningError(
        outcome.failure,
        outcome.detectionSource,
        outcome.transactionHash,
      );
    }
    this.setAuthorizationUsed(input.from, input.nonce, true);
    // If the test didn't bother setting a serviceId on the queued event
    // (the default is bytes32(0) from makePaymentSettledEvent), echo the
    // serviceId the caller passed in. This is what the real router does
    // — it emits the same value it received as input — and keeps
    // verifyAndSettle's "event.serviceId === challenge.serviceId" cross
    // -check from spuriously tripping in tests that don't care about it.
    const ZERO = "0x" + "00".repeat(32);
    const event = {
      ...outcome.event,
      serviceId:
        outcome.event.serviceId.toLowerCase() === ZERO
          ? input.serviceId
          : outcome.event.serviceId,
      serviceRef:
        outcome.event.serviceRef.toLowerCase() === ZERO
          ? input.serviceRef
          : outcome.event.serviceRef,
    };
    const result = { transactionHash: outcome.txHash, event };
    this.settlementResults.set(outcome.txHash.toLowerCase(), result);
    await onBroadcast?.(outcome.txHash);
    if (outcome.kind === "broadcast-error") {
      throw new Error(outcome.reason);
    }
    return result;
  }

  // ── Confirmation mock ────────────────────────────────────────────
  //
  // Tests exercise the gateway-side confirm flow without touching a real
  // EAS. Queue a result via queueConfirmation; otherwise the mock throws.
  private confirmationOutcomes: ConfirmationOutcome[] = [];
  public confirmations: ConfirmationDelegationInput[] = [];
  private nonces = new Map<string, bigint>();

  queueConfirmation(outcome: ConfirmationOutcome): void {
    this.confirmationOutcomes.push(outcome);
  }

  setEasAttesterNonce(attester: Hex, nonce: bigint): void {
    this.nonces.set(attester.toLowerCase(), nonce);
  }

  async submitBuyerConfirmation(
    input: ConfirmationDelegationInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<ConfirmationResult> {
    this.confirmations.push(input);
    const outcome = this.confirmationOutcomes.shift();
    if (!outcome) {
      throw new Error(
        "MockChainReader.submitBuyerConfirmation called with no queued outcome",
      );
    }
    if (outcome.kind === "revert") throw new Error(outcome.reason);
    // Stage-typed failures exercise the confirm-delivery taxonomy split
    // (pre-broadcast / reverted / unknown / attested-but-unrecorded).
    if (outcome.kind === "stage") {
      throw new ConfirmationSubmitError(outcome.stage, outcome.reason, {
        transactionHash: outcome.txHash,
        needsFreshSignature: outcome.needsFreshSignature,
      });
    }
    await onBroadcast?.(outcome.txHash);
    return { transactionHash: outcome.txHash, attestationUid: outcome.attestationUid };
  }

  async getEasAttesterNonce(attester: Hex): Promise<bigint> {
    return this.nonces.get(attester.toLowerCase()) ?? 0n;
  }

  // ── Registration mock (AgentIndex.registerWithSig) ───────────────
  //
  // Mirrors the buyer-confirmation pattern: queue an outcome before each
  // call. Successful registers also auto-update agentOfWallet so any
  // follow-up settlement sees the wallet as registered.
  private registrationNonces = new Map<string, bigint>();
  private registrationOutcomes: Array<
    | { kind: "success"; agentId: bigint; txHash: Hex }
    | { kind: "revert"; reason: string }
  > = [];
  public registrations: QueuedRegistrationInput[] = [];

  setRegistrationNonce(wallet: Hex, nonce: bigint): void {
    this.registrationNonces.set(wallet.toLowerCase(), nonce);
  }

  queueRegistration(
    outcome:
      | { kind: "success"; agentId: bigint; txHash: Hex }
      | { kind: "revert"; reason: string },
  ): void {
    this.registrationOutcomes.push(outcome);
  }

  async getRegistrationNonce(wallet: Hex): Promise<bigint> {
    return this.registrationNonces.get(wallet.toLowerCase()) ?? 0n;
  }

  private async applyQueuedRegistration(input: QueuedRegistrationInput) {
    this.registrations.push(input);
    const outcome = this.registrationOutcomes.shift();
    if (!outcome) {
      throw new Error(
        "MockChainReader registration called with no queued outcome",
      );
    }
    if (outcome.kind === "revert") throw new Error(outcome.reason);
    // Mirror the on-chain side-effects so subsequent reads see the new agent.
    this.setAgentOfWallet(input.agentWallet, outcome.agentId);
    const cur = this.registrationNonces.get(input.agentWallet.toLowerCase()) ?? 0n;
    this.registrationNonces.set(input.agentWallet.toLowerCase(), cur + 1n);
    return { agentId: outcome.agentId, transactionHash: outcome.txHash };
  }

  // ── settleWithRegistration mock ───────────────────────────────────
  //
  // Wraps the existing settle queue: tests call queueSettlement plus
  // (optionally) queueRegistration. If the buyer is already registered,
  // only queueSettlement is consumed.
  public settleWithRegistrationCalls: SettleWithRegistrationInput[] = [];

  // ── Block number mock ────────────────────────────────────────────
  //
  // Tests that exercise /public/v1/stats set this to a known value.
  // Default 0n is enough for tests that don't care.
  private blockNumber = 0n;

  setBlockNumber(value: bigint): void {
    this.blockNumber = value;
  }

  async getBlockNumber(): Promise<bigint> {
    return this.blockNumber;
  }

  setSanctionsReady(ready: boolean): void {
    this.sanctionsReady = ready;
  }

  async verifyDeploymentReadiness(): Promise<{
    ready: boolean;
    failedCheck: string | null;
  }> {
    return {
      ready: this.sanctionsReady,
      failedCheck: this.sanctionsReady ? null : "sanctions_oracle",
    };
  }

  // ── Reputation mock ──────────────────────────────────────────────
  //
  // Default null mirrors the production behavior when no
  // ReputationStorage is wired into the gateway. Tests that exercise
  // the reputation surface set explicit values via the setters.
  private providerReputations = new Map<string, ProviderReputation>();
  private serviceReputations = new Map<string, ServiceReputation>();
  private reputationConfigured = false;

  setProviderReputation(agentId: bigint, value: ProviderReputation): void {
    this.reputationConfigured = true;
    this.providerReputations.set(agentId.toString(), value);
  }

  setServiceReputation(serviceId: Hex, value: ServiceReputation): void {
    this.reputationConfigured = true;
    this.serviceReputations.set(serviceId.toLowerCase(), value);
  }

  async getProviderReputation(
    agentId: bigint,
  ): Promise<ProviderReputation | null> {
    if (!this.reputationConfigured) return null;
    return (
      this.providerReputations.get(agentId.toString()) ?? {
        completed: 0n,
        failed: 0n,
        canceled: 0n,
        confirmed: 0n,
        notConfirmed: 0n,
      }
    );
  }

  async getServiceReputation(
    serviceId: Hex,
  ): Promise<ServiceReputation | null> {
    if (!this.reputationConfigured) return null;
    return (
      this.serviceReputations.get(serviceId.toLowerCase()) ?? {
        completed: 0n,
        failed: 0n,
        canceled: 0n,
        confirmed: 0n,
        notConfirmed: 0n,
        totalRefunded: 0n,
      }
    );
  }

  // Per-paymentId record mock. Unlike the aggregate getters, "absent record"
  // is the common case (most paid rows haven't been outcome-attested yet),
  // so the absence-returns-null contract here mirrors the real reader's
  // "paymentId == 0 → null" path. Tests opt-in by calling setReputationRecord.
  private reputationRecords = new Map<string, ReputationRecord>();

  setReputationRecord(paymentId: bigint, value: ReputationRecord): void {
    this.reputationConfigured = true;
    this.reputationRecords.set(paymentId.toString(), value);
  }

  async getReputationRecord(
    paymentId: bigint,
  ): Promise<ReputationRecord | null> {
    if (!this.reputationConfigured) return null;
    return this.reputationRecords.get(paymentId.toString()) ?? null;
  }

  // Per-paymentId refund mock. Default 0n (settled, no refund), which
  // matches the PaymentRouter behavior — the contract returns 0 for both
  // unknown and unrefunded paymentIds. Tests that exercise refunds call
  // setPaymentRefundedAmount.
  private paymentRefunds = new Map<string, bigint>();

  setPaymentRefundedAmount(paymentId: bigint, atomic: bigint): void {
    this.paymentRefunds.set(paymentId.toString(), atomic);
  }

  async getPaymentRefundedAmount(paymentId: bigint): Promise<bigint> {
    return this.paymentRefunds.get(paymentId.toString()) ?? 0n;
  }

  // Per-paymentId PaymentRouter.getPayment mock. Default null (unknown
  // payment) mirrors the reader's zero-init detection; tests that exercise
  // the reputation mirror seed a record via setPaymentRecord.
  private paymentRecords = new Map<string, PaymentRouterRecord>();

  setPaymentRecord(paymentId: bigint, record: PaymentRouterRecord): void {
    this.paymentRecords.set(paymentId.toString(), record);
  }

  clearPaymentRecord(paymentId: bigint): void {
    this.paymentRecords.delete(paymentId.toString());
  }

  async getPaymentRecord(
    paymentId: bigint,
  ): Promise<PaymentRouterRecord | null> {
    return this.paymentRecords.get(paymentId.toString()) ?? null;
  }

  // ── Canonical ReputationRegistry feedback mock ──────────────────────
  //
  // Records every giveFeedback / revokeFeedback call so mirror tests can
  // assert on the exact args. Default outcome is success (with a 1-based
  // per-agent index, matching the canonical registry); tests exercising
  // failure paths queue reverts via queueFeedback / queueFeedbackRevoke.
  public feedbacks: FeedbackInput[] = [];
  public feedbackRevokes: Array<{ agentId: bigint; feedbackIndex: bigint }> =
    [];
  private feedbackOutcomes: Array<{
    kind: "permanent" | "transient";
    reason: string;
  }> = [];
  private feedbackRevokeOutcomes: Array<{ kind: "revert"; reason: string }> =
    [];
  private feedbackLastIndex = new Map<string, bigint>();
  private feedbackTransactions = new Map<string, FeedbackResult>();
  private feedbackNonce = 0n;
  private feedbackBroadcastNonce = 0n;

  queueFeedback(outcome: {
    kind: "permanent" | "transient";
    reason: string;
  }): void {
    this.feedbackOutcomes.push(outcome);
  }

  queueFeedbackRevoke(outcome: { kind: "revert"; reason: string }): void {
    this.feedbackRevokeOutcomes.push(outcome);
  }

  async prepareFeedback(
    _input: FeedbackInput,
  ): Promise<PreparedFeedbackTransaction> {
    const nonce = this.feedbackNonce++;
    return {
      nonce,
      transactionHash:
        `0xfade${nonce.toString(16).padStart(60, "0")}` as Hex,
      serializedTransaction:
        `0x02${nonce.toString(16).padStart(2, "0")}` as Hex,
    };
  }

  async submitPreparedFeedback(
    prepared: PreparedFeedbackTransaction,
    input: FeedbackInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<FeedbackResult> {
    this.feedbacks.push(input);
    const outcome = this.feedbackOutcomes.shift();
    if (outcome?.kind === "permanent") {
      throw new FeedbackSubmissionError("reverted", outcome.reason);
    }
    if (outcome) throw new Error(outcome.reason);
    const key = input.agentId.toString();
    const next = (this.feedbackLastIndex.get(key) ?? 0n) + 1n;
    this.feedbackLastIndex.set(key, next);
    const result = {
      transactionHash: prepared.transactionHash,
      feedbackIndex: next,
    };
    this.feedbackTransactions.set(
      prepared.transactionHash.toLowerCase(),
      result,
    );
    if (prepared.nonce >= this.feedbackBroadcastNonce) {
      this.feedbackBroadcastNonce = prepared.nonce + 1n;
    }
    await onBroadcast?.(prepared.transactionHash);
    return result;
  }

  async getFeedbackByTransaction(
    transactionHash: Hex,
    _input: FeedbackInput,
  ): Promise<FeedbackResult | null> {
    return this.feedbackTransactions.get(transactionHash.toLowerCase()) ?? null;
  }

  async getFacilitatorTransactionCount(): Promise<bigint> {
    return this.feedbackBroadcastNonce;
  }

  async revokeFeedback(
    agentId: bigint,
    feedbackIndex: bigint,
    onBroadcast?: BroadcastObserver,
  ): Promise<FeedbackResult> {
    this.feedbackRevokes.push({ agentId, feedbackIndex });
    const outcome = this.feedbackRevokeOutcomes.shift();
    if (outcome) throw new Error(outcome.reason);
    const result = {
      transactionHash:
        `0xdead${feedbackIndex.toString(16).padStart(60, "0")}` as Hex,
    };
    await onBroadcast?.(result.transactionHash);
    return result;
  }

  private chainProjectionEvents: ChainProjectionEvent[] = [];

  /**
   * Test helper to seed normalized projection events for the indexer.
   */
  pushChainProjectionEvent(event: ChainProjectionEvent): void {
    this.chainProjectionEvents.push(event);
  }

  async getChainProjectionEvents(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<ChainProjectionEvent[]> {
    return this.chainProjectionEvents.filter(
      (event) =>
        event.blockNumber >= fromBlock && event.blockNumber <= toBlock,
    );
  }

  async settleWithRegistration(
    input: SettleWithRegistrationInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<SettleWithRegistrationResult> {
    this.settleWithRegistrationCalls.push(input);
    let registered = false;
    const existing = await this.agentOfWallet(input.from);
    if (existing === 0n) {
      const reg = await this.applyQueuedRegistration({
        agentURI: input.registration.agentURI,
        agentWallet: input.from,
        deadline: input.registration.deadline,
        signature: input.registration.signature,
      });
      registered = true;
      // Settlement queue can be parameterised on buyerAgentId by the test;
      // we just record what the registration produced.
      reg;
    }
    const settled = await this.settlePayment(input, onBroadcast);
    return {
      transactionHash: settled.transactionHash,
      event: settled.event,
      buyerAgentId: settled.event.buyerAgentId,
      registered,
    };
  }

  async getSettlementByTransaction(
    transactionHash: Hex,
    serviceRef: Hex,
  ): Promise<SettlementResult> {
    const recoveryError = this.settlementRecoveryErrors.get(
      transactionHash.toLowerCase(),
    );
    if (recoveryError) throw recoveryError;
    const result = this.settlementResults.get(transactionHash.toLowerCase());
    if (!result || result.event.serviceRef.toLowerCase() !== serviceRef.toLowerCase()) {
      throw new Error("mock settlement transaction not found");
    }
    return result;
  }
}

export function makePaymentSettledEvent(args: {
  paymentId: bigint;
  serviceRef: Hex;
  // Optional in helpers so tests that don't care about the serviceId
  // dimension still compile. Production never emits a zero serviceId.
  serviceId?: Hex;
  buyerAgentId: bigint;
  providerAgentId: bigint;
  totalAmount: bigint;
  token?: Hex;
}): PaymentSettledEvent {
  const commission = (args.totalAmount * 5n) / 100n;
  const providerAmount = args.totalAmount - commission;
  return {
    paymentId: args.paymentId,
    serviceRef: args.serviceRef,
    serviceId: args.serviceId ?? (("0x" + "00".repeat(32)) as Hex),
    buyerAgentId: args.buyerAgentId,
    providerAgentId: args.providerAgentId,
    token: args.token ?? ("0x000000000000000000000000000000000000a003" as Hex),
    totalAmount: args.totalAmount,
    providerAmount,
    commission,
  };
}
