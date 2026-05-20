import type { PaymentSettledEventLog } from "../../src/chain/reader.js";
import type {
  BuyerReputation,
  ChainReader,
  ConfirmationDelegationInput,
  ConfirmationResult,
  PaymentSettledEvent,
  ProviderReputation,
  RegisterBySigInput,
  RegisterBySigResult,
  ReputationRecord,
  ServiceReputation,
  SettleWithRegistrationInput,
  SettleWithRegistrationResult,
  SettlementInput,
  SettlementResult,
} from "../../src/chain/reader.js";
import type { Hex } from "../../src/types.js";

interface MockProviderEntry {
  walletAddress: Hex;
  agentId: bigint;
  registrationTime: bigint;
  isActive: boolean;
}

export type SettlementOutcome =
  | { kind: "success"; event: PaymentSettledEvent; txHash: Hex }
  | { kind: "revert"; reason: string };

/**
 * In-memory ChainReader. Tests feed it provider data, nonce state, and a
 * scripted sequence of settlement outcomes.
 */
export class MockChainReader implements ChainReader {
  private providers = new Map<string, MockProviderEntry>();
  private providerOrder: bigint[] = [];
  // agentURI stored separately to mirror the IdentityRegistry lookup.
  private agentURIs = new Map<string, string>();
  private authStates = new Map<string, boolean>();
  private outcomes: SettlementOutcome[] = [];

  public settlements: SettlementInput[] = [];

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
    if (!entry) throw new Error(`provider ${agentId} not found`);
    return entry;
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

  // Reverse-index. Tests that care about identity lookups call
  // setAgentOfWallet; default is 0n (= unregistered).
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

  setAgentWallet(agentId: bigint, wallet: Hex): void {
    this.agentWalletOverrides.set(agentId.toString(), wallet.toLowerCase() as Hex);
  }

  async getAgentWallet(agentId: bigint): Promise<Hex> {
    const override = this.agentWalletOverrides.get(agentId.toString());
    if (override) return override;
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

  async settlePayment(input: SettlementInput): Promise<SettlementResult> {
    this.settlements.push(input);
    const outcome = this.outcomes.shift();
    if (!outcome) {
      throw new Error(
        "MockChainReader.settlePayment called with no queued outcome",
      );
    }
    if (outcome.kind === "revert") throw new Error(outcome.reason);
    this.setAuthorizationUsed(input.from, input.nonce, true);
    // If the test didn't bother setting a serviceId on the queued event
    // (the default is bytes32(0) from makePaymentSettledEvent), echo the
    // serviceId the caller passed in. This is what the real router does
    // — it emits the same value it received as input — and keeps
    // verifyAndSettle's "event.serviceId === challenge.serviceId" cross
    // -check from spuriously tripping in tests that don't care about it.
    const ZERO = "0x" + "00".repeat(32);
    const event =
      outcome.event.serviceId.toLowerCase() === ZERO
        ? { ...outcome.event, serviceId: input.serviceId }
        : outcome.event;
    return { transactionHash: outcome.txHash, event };
  }

  // ── Confirmation mock ────────────────────────────────────────────
  //
  // Tests exercise the gateway-side confirm flow without touching a real
  // EAS. Queue a result via queueConfirmation; otherwise the mock throws.
  private confirmationOutcomes: Array<
    | { kind: "success"; txHash: Hex; attestationUid: Hex }
    | { kind: "revert"; reason: string }
  > = [];
  public confirmations: ConfirmationDelegationInput[] = [];
  private nonces = new Map<string, bigint>();

  queueConfirmation(
    outcome:
      | { kind: "success"; txHash: Hex; attestationUid: Hex }
      | { kind: "revert"; reason: string },
  ): void {
    this.confirmationOutcomes.push(outcome);
  }

  setEasAttesterNonce(attester: Hex, nonce: bigint): void {
    this.nonces.set(attester.toLowerCase(), nonce);
  }

  async submitBuyerConfirmation(
    input: ConfirmationDelegationInput,
  ): Promise<ConfirmationResult> {
    this.confirmations.push(input);
    const outcome = this.confirmationOutcomes.shift();
    if (!outcome) {
      throw new Error(
        "MockChainReader.submitBuyerConfirmation called with no queued outcome",
      );
    }
    if (outcome.kind === "revert") throw new Error(outcome.reason);
    return { transactionHash: outcome.txHash, attestationUid: outcome.attestationUid };
  }

  async getEasAttesterNonce(attester: Hex): Promise<bigint> {
    return this.nonces.get(attester.toLowerCase()) ?? 0n;
  }

  // ── Registration mock ────────────────────────────────────────────
  //
  // Mirrors the buyer-confirmation pattern: queue an outcome before each
  // call. Successful registers also auto-update agentOfWallet so any
  // follow-up settlement sees the wallet as registered.
  private registrationNonces = new Map<string, bigint>();
  private registrationOutcomes: Array<
    | { kind: "success"; agentId: bigint; txHash: Hex }
    | { kind: "revert"; reason: string }
  > = [];
  public registrations: RegisterBySigInput[] = [];

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

  async registerBuyer(input: RegisterBySigInput): Promise<RegisterBySigResult> {
    this.registrations.push(input);
    const outcome = this.registrationOutcomes.shift();
    if (!outcome) {
      throw new Error(
        "MockChainReader.registerBuyer called with no queued outcome",
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

  // ── Reputation mock ──────────────────────────────────────────────
  //
  // Default null mirrors the production behavior when no
  // ReputationStorage is wired into the gateway. Tests that exercise
  // the reputation surface set explicit values via the setters.
  private providerReputations = new Map<string, ProviderReputation>();
  private buyerReputations = new Map<string, BuyerReputation>();
  private serviceReputations = new Map<string, ServiceReputation>();
  private reputationConfigured = false;

  setProviderReputation(agentId: bigint, value: ProviderReputation): void {
    this.reputationConfigured = true;
    this.providerReputations.set(agentId.toString(), value);
  }

  setBuyerReputation(agentId: bigint, value: BuyerReputation): void {
    this.reputationConfigured = true;
    this.buyerReputations.set(agentId.toString(), value);
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

  async getBuyerReputation(
    agentId: bigint,
  ): Promise<BuyerReputation | null> {
    if (!this.reputationConfigured) return null;
    return (
      this.buyerReputations.get(agentId.toString()) ?? {
        transactions: 0n,
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

  private paymentSettledLogs: PaymentSettledEventLog[] = [];

  /**
   * Test helper to seed PaymentSettled event logs for the indexer to
   * consume. Tests call this before the indexer ticks; the indexer
   * fetches via getPaymentSettledEvents and gets whatever was queued.
   */
  pushPaymentSettledLog(log: PaymentSettledEventLog): void {
    this.paymentSettledLogs.push(log);
  }

  async getPaymentSettledEvents(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<PaymentSettledEventLog[]> {
    return this.paymentSettledLogs.filter(
      (l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock,
    );
  }

  async settleWithRegistration(
    input: SettleWithRegistrationInput,
  ): Promise<SettleWithRegistrationResult> {
    this.settleWithRegistrationCalls.push(input);
    let registered = false;
    const existing = await this.agentOfWallet(input.from);
    if (existing === 0n) {
      const reg = await this.registerBuyer({
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
    const settled = await this.settlePayment(input);
    return {
      transactionHash: settled.transactionHash,
      event: settled.event,
      buyerAgentId: settled.event.buyerAgentId,
      registered,
    };
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
