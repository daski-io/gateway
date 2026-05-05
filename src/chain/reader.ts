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

    const agentURI = await reader.getAgentURI(agentId);

    providers.push({
      agentId,
      walletAddress: provider.walletAddress,
      agentURI,
      registrationTime: provider.registrationTime,
      isActive: true,
      isWhitelisted: true,
    });
  }

  return providers;
}
