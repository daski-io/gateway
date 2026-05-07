import type {
  BuyerReputation,
  ChainReader,
  ConfirmationDelegationInput,
  ConfirmationResult,
  PaymentSettledEvent,
  ProviderReputation,
  RegisterBySigInput,
  RegisterBySigResult,
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

  // Reverse-index. Tests that care about identity lookups call
  // setAgentOfWallet; default is 0n (= unregistered).
  private walletToAgent = new Map<string, bigint>();

  setAgentOfWallet(wallet: Hex, agentId: bigint): void {
    this.walletToAgent.set(wallet.toLowerCase(), agentId);
  }

  async agentOfWallet(wallet: Hex): Promise<bigint> {
    return this.walletToAgent.get(wallet.toLowerCase()) ?? 0n;
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
    return { transactionHash: outcome.txHash, event: outcome.event };
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
  private reputationConfigured = false;

  setProviderReputation(agentId: bigint, value: ProviderReputation): void {
    this.reputationConfigured = true;
    this.providerReputations.set(agentId.toString(), value);
  }

  setBuyerReputation(agentId: bigint, value: BuyerReputation): void {
    this.reputationConfigured = true;
    this.buyerReputations.set(agentId.toString(), value);
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
    buyerAgentId: args.buyerAgentId,
    providerAgentId: args.providerAgentId,
    token: args.token ?? ("0x000000000000000000000000000000000000a003" as Hex),
    totalAmount: args.totalAmount,
    providerAmount,
    commission,
  };
}
