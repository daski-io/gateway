/**
 * Runtime ChainReader for `CHAIN_MODE=mock` boots — auto-succeeds on every
 * call so the gateway can serve a full discover → 402 → settle → confirm
 * cycle without touching a real chain.
 *
 * Distinct from the test fixture in `test/helpers/mockChain.ts`: the test
 * fixture requires every outcome to be queued up-front (each settle pops
 * a pre-staged result), which is the right contract for unit tests but
 * unworkable for a long-running dev server hit by an orchestrated e2e
 * suite. This reader instead invents deterministic but unique values
 * (monotonic paymentIds, deterministic tx hashes) and treats every
 * settlement as a success.
 *
 * No persistence: state lives in-process and is lost when the gateway
 * restarts. That is the right contract for `npm run e2e:local:managed` —
 * the orchestrator restarts the gateway each run for a clean slate.
 */
import type { Hex } from "../types.js";
import type {
  ChainReader,
  ConfirmationDelegationInput,
  ConfirmationResult,
  FeedbackInput,
  FeedbackResult,
  PreparedFeedbackTransaction,
  PreparedConfirmationTransaction,
  FeedbackRevocationInput,
  PreparedSettlementTransaction,
  PaymentRouterRecord,
  PaymentSettledEvent,
  ProviderReputation,
  ReputationRecord,
  ServiceReputation,
  SettleWithRegistrationInput,
  SettlementInput,
  SettlementResult,
  ServiceSettlementSnapshot,
  BroadcastObserver,
} from "./reader.js";

const ZERO_HASH = ("0x" + "00".repeat(32)) as Hex;
const ZERO_ADDRESS = ("0x" + "00".repeat(20)) as Hex;
const ZERO_ADDR = ("0x" + "00".repeat(20)) as Hex;

export interface AutoMockChainReaderOptions {
  /** Token (USDC) address — emitted on PaymentSettled events. */
  tokenAddress: Hex;
  /** Provider's wallet address — informational, threaded into events. */
  providerWalletAddress: Hex;
  /** Provider agentId — the single registered provider in the mock registry. */
  providerAgentId: bigint;
  /**
   * `agentURI` returned by `getAgentURI(providerAgentId)`. The gateway's
   * cache fetches this URL to populate the Agent Card; in the managed
   * e2e setup it points at the local daski-provider's
   * /.well-known/agent.json.
   */
  providerAgentUri: string;
  /**
   * agentId reported for any buyer wallet that isn't otherwise pre-
   * registered. The mock test stack is single-buyer; the orchestrator
   * sets this so the provider's mock paymentVerifier and the buyer's
   * envelope claim agree on the same value (default 99).
   */
  defaultBuyerAgentId?: bigint;
}

function txHashForPayment(paymentId: bigint): Hex {
  const hex = paymentId.toString(16).padStart(64, "0");
  return `0x${hex}` as Hex;
}

function deterministicHex(seed: string, n: bigint): Hex {
  const tag = seed.slice(0, 1).charCodeAt(0).toString(16).padStart(2, "0");
  const body = n.toString(16).padStart(62, "0");
  return `0x${tag}${body}` as Hex;
}

export class AutoMockChainReader implements ChainReader {
  // Boot-time base rather than 1n: the mock chain restarts with the
  // gateway, but the PROVIDER's database persists across managed-e2e
  // runs. Re-issuing paymentId 1 with a fresh serviceRef collides with
  // the provider's immutable settlement-observation for the previous
  // run's paymentId 1 ("Settlement identity conflicts with persisted
  // chain facts"). A millisecond base keeps ids unique across restarts.
  private nextPaymentId = BigInt(Date.now());
  private confirmationCount = 0n;
  private blockNumber = 1n;
  private usedAuthNonces = new Set<string>();
  private settlementResults = new Map<string, SettlementResult>();
  private preparedSettlements = new Map<
    string,
    { input: SettlementInput; result: SettlementResult; registered?: boolean }
  >();
  private facilitatorPreparedNonce = 0n;
  private facilitatorConfirmedNonce = 0n;
  private agentByWallet = new Map<string, bigint>();
  private readonly defaultBuyerAgentId: bigint;

  constructor(private readonly opts: AutoMockChainReaderOptions) {
    this.defaultBuyerAgentId = opts.defaultBuyerAgentId ?? 99n;
  }

  // ── ProviderRegistry views ─────────────────────────────────────────

  async getProviderCount(): Promise<bigint> {
    return 1n;
  }

  async getProviderIdAt(index: bigint): Promise<bigint> {
    if (index !== 0n) {
      throw new Error(`mock provider index ${index} out of range`);
    }
    return this.opts.providerAgentId;
  }

  async getProvider(agentId: bigint): Promise<{
    agentId: bigint;
    registrationTime: bigint;
    isActive: boolean;
  }> {
    if (agentId !== this.opts.providerAgentId) {
      throw new Error(`mock provider ${agentId} not registered`);
    }
    return {
      agentId,
      registrationTime: 1n,
      isActive: true,
    };
  }

  async getProviderAuthority(agentId: bigint, blockNumber: bigint) {
    const provider = await this.getProvider(agentId);
    if (!provider.isActive) {
      return {
        ...provider,
        walletAddress: ZERO_ADDRESS,
        agentURI: "",
        observedBlock: blockNumber,
      };
    }
    return {
      ...provider,
      walletAddress: await this.getAgentWallet(agentId),
      agentURI: await this.getAgentURI(agentId),
      observedBlock: blockNumber,
    };
  }

  async getServiceSettlement(
    serviceId: Hex,
  ): Promise<ServiceSettlementSnapshot> {
    const wallet = await this.getAgentWallet(this.opts.providerAgentId);
    return {
      serviceId,
      providerAgentId: this.opts.providerAgentId,
      active: true,
      providerOwner: wallet,
      providerWallet: wallet,
      payee: wallet,
      observedBlock: this.blockNumber,
    };
  }

  // ── IdentityRegistry / AgentIndex views ────────────────────────────

  async getAgentURI(agentId: bigint): Promise<string> {
    if (agentId === this.opts.providerAgentId) {
      return this.opts.providerAgentUri;
    }
    // Buyers don't have an agentURI in this mock (they registered with "").
    return "";
  }

  // Mirrors AgentIndex.resolve — the in-memory map plays the role of the
  // verified wallet→agentId binding (no staleness in mock mode).
  async agentOfWallet(wallet: Hex): Promise<bigint> {
    return this.agentByWallet.get(wallet.toLowerCase()) ?? 0n;
  }

  async getAgentWallet(agentId: bigint): Promise<Hex> {
    if (agentId === this.opts.providerAgentId) {
      return this.opts.providerWalletAddress.toLowerCase() as Hex;
    }
    for (const [wallet, id] of this.agentByWallet) {
      if (id === agentId) return wallet as Hex;
    }
    return ZERO_ADDR;
  }

  async getAgentOwner(agentId: bigint): Promise<Hex> {
    return this.getAgentWallet(agentId);
  }

  async getRegistrationNonce(_wallet: Hex): Promise<bigint> {
    return 0n;
  }

  async verifyDeploymentReadiness() {
    return { ready: true, failedCheck: null };
  }

  async authorizationUsed(authorizer: Hex, nonce: Hex): Promise<boolean> {
    return this.usedAuthNonces.has(
      `${authorizer.toLowerCase()}:${nonce.toLowerCase()}`,
    );
  }

  async verifyReceiveAuthorization(): Promise<boolean> {
    return true;
  }

  // ── Settlement ──────────────────────────────────────────────────────

  private rememberBuyer(wallet: Hex): bigint {
    const key = wallet.toLowerCase();
    let id = this.agentByWallet.get(key);
    if (!id) {
      // All buyers map to the same agentId in single-buyer mock mode.
      // Real chain assigns unique ids, but the orchestrated test pins this
      // so the provider's mock paymentVerifier and the buyer's envelope
      // claim agree.
      id = this.defaultBuyerAgentId;
      this.agentByWallet.set(key, id);
    }
    return id;
  }

  async prepareSettlement(
    input: SettlementInput,
    facilitatorNonce: bigint,
  ): Promise<PreparedSettlementTransaction> {
    const key = `${input.from.toLowerCase()}:${input.nonce.toLowerCase()}`;
    if (this.usedAuthNonces.has(key)) {
      throw new Error("mock settle: authorization nonce already used");
    }
    const buyerAgentId = this.rememberBuyer(input.from);
    const paymentId = this.nextPaymentId++;
    const commission = (input.amount * 5n) / 100n;
    const event: PaymentSettledEvent = {
      paymentId,
      serviceRef: input.serviceRef,
      serviceId: input.serviceId,
      buyerAgentId,
      providerAgentId: input.providerAgentId,
      token: this.opts.tokenAddress.toLowerCase() as Hex,
      totalAmount: input.amount,
      providerAmount: input.amount - commission,
      commission,
    };
    // Payment tx hashes encode paymentId directly so the provider's mock
    // paymentVerifier can recover it via `BigInt(transactionHash)`.
    const result = {
      transactionHash: txHashForPayment(paymentId),
      event,
    };
    const nonce = facilitatorNonce;
    this.recordPreparedFacilitatorNonce(nonce);
    this.preparedSettlements.set(result.transactionHash.toLowerCase(), {
      input,
      result,
    });
    return {
      kind: "settle",
      transactionHash: result.transactionHash,
      serializedTransaction:
        `0x02${nonce.toString(16).padStart(2, "0")}` as Hex,
      facilitatorNonce: nonce,
    };
  }

  async prepareSettlementWithRegistration(
    input: SettleWithRegistrationInput,
    facilitatorNonce: bigint,
  ): Promise<PreparedSettlementTransaction> {
    const existed = this.agentByWallet.has(input.from.toLowerCase());
    const prepared = await this.prepareSettlement(input, facilitatorNonce);
    const pending = this.preparedSettlements.get(
      prepared.transactionHash.toLowerCase(),
    );
    if (pending) pending.registered = !existed;
    return { ...prepared, kind: "settle_with_registration" };
  }

  async submitPreparedSettlement(
    prepared: PreparedSettlementTransaction,
    expectedServiceRef: Hex,
    onBroadcast?: BroadcastObserver,
  ): Promise<SettlementResult & { registered?: boolean }> {
    const pending = this.preparedSettlements.get(
      prepared.transactionHash.toLowerCase(),
    );
    if (!pending) throw new Error("mock prepared settlement not found");
    const { input, result } = pending;
    if (
      result.event.serviceRef.toLowerCase() !== expectedServiceRef.toLowerCase()
    ) {
      throw new Error("mock settlement serviceRef mismatch");
    }
    this.usedAuthNonces.add(
      `${input.from.toLowerCase()}:${input.nonce.toLowerCase()}`,
    );
    this.settlementResults.set(result.transactionHash.toLowerCase(), result);
    this.recordConfirmedFacilitatorNonce(prepared.facilitatorNonce);
    await onBroadcast?.(result.transactionHash);
    return {
      ...result,
      ...(prepared.kind === "settle_with_registration"
        ? { registered: pending.registered ?? false }
        : {}),
    };
  }

  async findSettlementByTransaction(
    transactionHash: Hex,
    serviceRef: Hex,
  ): Promise<SettlementResult | null> {
    const result = this.settlementResults.get(transactionHash.toLowerCase());
    return result?.event.serviceRef.toLowerCase() === serviceRef.toLowerCase()
      ? result
      : null;
  }

  // ── Buyer confirmation (delegated EAS) ──────────────────────────────

  private preparedConfirmations = new Map<string, ConfirmationResult>();

  async prepareBuyerConfirmation(
    _input: ConfirmationDelegationInput,
    facilitatorNonce: bigint,
  ): Promise<PreparedConfirmationTransaction> {
    this.confirmationCount++;
    const result = {
      transactionHash: deterministicHex("c", this.confirmationCount),
      attestationUid: deterministicHex("a", this.confirmationCount),
    };
    this.preparedConfirmations.set(
      result.transactionHash.toLowerCase(),
      result,
    );
    this.recordPreparedFacilitatorNonce(facilitatorNonce);
    return {
      transactionHash: result.transactionHash,
      serializedTransaction: deterministicHex("d", this.confirmationCount),
      facilitatorNonce,
    };
  }

  async submitPreparedBuyerConfirmation(
    prepared: PreparedConfirmationTransaction,
    _input: ConfirmationDelegationInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<ConfirmationResult> {
    const result = this.preparedConfirmations.get(
      prepared.transactionHash.toLowerCase(),
    );
    if (!result) throw new Error("mock confirmation transaction not found");
    this.recordConfirmedFacilitatorNonce(prepared.facilitatorNonce);
    await onBroadcast?.(result.transactionHash);
    return result;
  }

  async getBuyerConfirmationByTransaction(transactionHash: Hex) {
    return this.preparedConfirmations.get(transactionHash.toLowerCase()) ?? null;
  }

  async getEasAttesterNonce(_attester: Hex): Promise<bigint> {
    return 0n;
  }

  // ── Public stats helpers ────────────────────────────────────────────

  async getBlockNumber(): Promise<bigint> {
    return ++this.blockNumber;
  }

  // ── Reputation ──────────────────────────────────────────────────────

  async getProviderReputation(
    _agentId: bigint,
  ): Promise<ProviderReputation | null> {
    return {
      completed: 0n,
      failed: 0n,
      canceled: 0n,
      confirmed: 0n,
      notConfirmed: 0n,
    };
  }

  async getServiceReputation(
    _serviceId: Hex,
  ): Promise<ServiceReputation | null> {
    return {
      completed: 0n,
      failed: 0n,
      canceled: 0n,
      confirmed: 0n,
      notConfirmed: 0n,
      totalRefunded: 0n,
    };
  }

  /**
   * Returns an "outcome recorded" record for any nonzero paymentId, so
   * buyers that poll for the provider's outcome attestation (daski-test
   * step 9, testnet mode) see immediate success in mock mode.
   */
  async getReputationRecord(
    paymentId: bigint,
  ): Promise<ReputationRecord | null> {
    if (paymentId === 0n) return null;
    return {
      paymentId,
      providerAgentId: this.opts.providerAgentId,
      buyerAgentId: 0n,
      serviceId: ZERO_HASH,
      outcome: "Completed",
      confirmation: "Pending",
      fulfillmentSeconds: 1n,
      outcomeTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      confirmationTimestamp: 0n,
      currentConfirmationUid: ZERO_HASH,
      outcomeRecorded: true,
      reputationEligible: true,
    };
  }

  /**
   * Synthetic PaymentRecord for any nonzero paymentId — mirrors the
   * single-provider mock world (provider = the configured agentId). The
   * reputation mirror never runs in CHAIN_MODE=mock, so this exists for
   * interface completeness, not behavior.
   */
  async getPaymentRecord(
    paymentId: bigint,
  ): Promise<PaymentRouterRecord | null> {
    if (paymentId === 0n) return null;
    return {
      buyerAgentId: this.defaultBuyerAgentId,
      providerAgentId: this.opts.providerAgentId,
      serviceId: ZERO_HASH,
      token: this.opts.tokenAddress.toLowerCase() as Hex,
      amount: 0n,
      cachedBuyerWallet: ZERO_ADDR,
      cachedProviderOwner: this.opts.providerWalletAddress,
      cachedProviderWallet: this.opts.providerWalletAddress,
      serviceRef: ZERO_HASH,
      paidAt: BigInt(Math.floor(Date.now() / 1000)),
      reputationEligible: true,
    };
  }

  // ── Canonical ReputationRegistry feedback (mirror) ──────────────────
  //
  // The mirror is disabled in CHAIN_MODE=mock, so these are auto-success
  // stubs recording calls for completeness/debugging only. Indices are
  // 1-based per (agentId), matching the canonical registry's semantics.

  public feedbacks: FeedbackInput[] = [];
  private feedbackIndexByAgent = new Map<string, bigint>();

  async prepareFeedback(
    _input: FeedbackInput,
    facilitatorNonce: bigint,
  ): Promise<PreparedFeedbackTransaction> {
    this.recordPreparedFacilitatorNonce(facilitatorNonce);
    return {
      facilitatorNonce,
      transactionHash: deterministicHex("f", facilitatorNonce + 1n),
      serializedTransaction: deterministicHex("e", facilitatorNonce + 1n),
    };
  }

  async submitPreparedFeedback(
    prepared: PreparedFeedbackTransaction,
    input: FeedbackInput,
    onBroadcast?: import("./reader.js").BroadcastObserver,
  ): Promise<FeedbackResult> {
    this.feedbacks.push(input);
    const key = input.agentId.toString();
    const next = (this.feedbackIndexByAgent.get(key) ?? 0n) + 1n;
    this.feedbackIndexByAgent.set(key, next);
    this.recordConfirmedFacilitatorNonce(prepared.facilitatorNonce);
    await onBroadcast?.(prepared.transactionHash);
    return {
      transactionHash: prepared.transactionHash,
      feedbackIndex: next,
    };
  }

  async getFeedbackByTransaction(
    _transactionHash: Hex,
    _input: FeedbackInput,
  ): Promise<FeedbackResult | null> {
    return null;
  }

  async getFacilitatorTransactionCount(): Promise<bigint> {
    return this.facilitatorConfirmedNonce;
  }

  async getFacilitatorPendingTransactionCount(): Promise<bigint> {
    return this.facilitatorPreparedNonce > this.facilitatorConfirmedNonce
      ? this.facilitatorPreparedNonce
      : this.facilitatorConfirmedNonce;
  }

  async prepareFeedbackRevocation(
    input: FeedbackRevocationInput,
    facilitatorNonce: bigint,
  ): Promise<PreparedFeedbackTransaction> {
    this.recordPreparedFacilitatorNonce(facilitatorNonce);
    return {
      transactionHash: deterministicHex("v", input.feedbackIndex),
      serializedTransaction: deterministicHex("r", input.feedbackIndex),
      facilitatorNonce,
    };
  }

  async submitPreparedFeedbackRevocation(
    prepared: PreparedFeedbackTransaction,
    _input: FeedbackRevocationInput,
    onBroadcast?: BroadcastObserver,
  ): Promise<FeedbackResult> {
    const result = { transactionHash: prepared.transactionHash };
    this.recordConfirmedFacilitatorNonce(prepared.facilitatorNonce);
    await onBroadcast?.(result.transactionHash);
    return result;
  }

  async getFeedbackRevocationByTransaction(
    _transactionHash: Hex,
    _input: FeedbackRevocationInput,
  ): Promise<FeedbackResult | null> {
    return null;
  }

  async getChainProjectionEvents(_from: bigint, _to: bigint) {
    return [];
  }

  private recordPreparedFacilitatorNonce(nonce: bigint): void {
    if (nonce >= this.facilitatorPreparedNonce) {
      this.facilitatorPreparedNonce = nonce + 1n;
    }
  }

  private recordConfirmedFacilitatorNonce(nonce: bigint): void {
    if (nonce >= this.facilitatorConfirmedNonce) {
      this.facilitatorConfirmedNonce = nonce + 1n;
    }
  }
}
