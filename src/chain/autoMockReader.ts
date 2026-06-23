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
  BuyerReputation,
  ChainReader,
  ConfirmationDelegationInput,
  ConfirmationResult,
  PaymentSettledEvent,
  PaymentSettledEventLog,
  ProviderReputation,
  RegisterBySigInput,
  RegisterBySigResult,
  ReputationRecord,
  ServiceReputation,
  SettleWithRegistrationInput,
  SettleWithRegistrationResult,
  SettlementInput,
  SettlementResult,
} from "./reader.js";

const ZERO_HASH = ("0x" + "00".repeat(32)) as Hex;
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
  private nextPaymentId = 1n;
  private confirmationCount = 0n;
  private blockNumber = 1n;
  private usedAuthNonces = new Set<string>();
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

  // ── IdentityRegistry views ─────────────────────────────────────────

  async getAgentURI(agentId: bigint): Promise<string> {
    if (agentId === this.opts.providerAgentId) {
      return this.opts.providerAgentUri;
    }
    // Buyers don't have an agentURI in this mock (they registered with "").
    return "";
  }

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

  async getRegistrationNonce(_wallet: Hex): Promise<bigint> {
    return 0n;
  }

  async authorizationUsed(authorizer: Hex, nonce: Hex): Promise<boolean> {
    return this.usedAuthNonces.has(
      `${authorizer.toLowerCase()}:${nonce.toLowerCase()}`,
    );
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

  async settlePayment(input: SettlementInput): Promise<SettlementResult> {
    const key = `${input.from.toLowerCase()}:${input.nonce.toLowerCase()}`;
    if (this.usedAuthNonces.has(key)) {
      throw new Error("mock settle: authorization nonce already used");
    }
    this.usedAuthNonces.add(key);

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
    return {
      transactionHash: txHashForPayment(paymentId),
      event,
    };
  }

  async settleWithRegistration(
    input: SettleWithRegistrationInput,
  ): Promise<SettleWithRegistrationResult> {
    const existed = this.agentByWallet.has(input.from.toLowerCase());
    const result = await this.settlePayment(input);
    return {
      transactionHash: result.transactionHash,
      event: result.event,
      buyerAgentId: result.event.buyerAgentId,
      registered: !existed,
    };
  }

  async registerBuyer(input: RegisterBySigInput): Promise<RegisterBySigResult> {
    const agentId = this.rememberBuyer(input.agentWallet);
    return {
      agentId,
      transactionHash: deterministicHex("r", agentId),
    };
  }

  // ── Buyer confirmation (delegated EAS) ──────────────────────────────

  async submitBuyerConfirmation(
    _input: ConfirmationDelegationInput,
  ): Promise<ConfirmationResult> {
    this.confirmationCount++;
    return {
      transactionHash: deterministicHex("c", this.confirmationCount),
      attestationUid: deterministicHex("a", this.confirmationCount),
    };
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

  async getBuyerReputation(
    _agentId: bigint,
  ): Promise<BuyerReputation | null> {
    return { transactions: 0n, confirmed: 0n, notConfirmed: 0n };
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
      outcomeRecorded: true,
    };
  }

  async getPaymentRefundedAmount(_paymentId: bigint): Promise<bigint> {
    return 0n;
  }

  async getPaymentSettledEvents(
    _from: bigint,
    _to: bigint,
  ): Promise<PaymentSettledEventLog[]> {
    return [];
  }
}
