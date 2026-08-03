import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  nonceManager,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { paymentRouterAbi, usdcAbi } from "./abis.js";
import type { ChainReader, PaymentRouterRecord } from "./reader.js";
import type { ChainId, Hex } from "../types.js";
import type { UsdcDomainConfig } from "../payment/usdcDomain.js";
import { createIdentityMethods } from "./viemIdentity.js";
import { createReputationReadMethods } from "./viemReputationRead.js";
import { createFeedbackMethods } from "./viemFeedback.js";
import { createConfirmationMethods } from "./viemConfirmation.js";
import { createViemEventReader } from "./viemEventReader.js";
import { createViemDeploymentReadiness } from "./viemDeploymentReadiness.js";
import { createSettlementMethods } from "./viemSettlement.js";
import { logger } from "../util/logger.js";
export { decodeRevertReason } from "./viemErrors.js";

// Shared transport builder: ordered fallback plus throttle visibility.
// viem's in-client retries absorb HTTP 429s silently — the 2026-08-01
// post-mortem found a permanent ~32% throttle floor that no log line had
// ever surfaced. One WARN per label per minute is enough to see it
// without becoming its own log flood. The label is a workload name, never
// a URL (RPC URLs can carry keyed paths).
export function buildChainTransport(
  primaryUrl: string,
  fallbackUrls: string[] | undefined,
  label: string,
) {
  let lastThrottleLogAt = 0;
  const onFetchResponse = (response: { status: number }) => {
    if (response.status !== 429) return;
    const now = Date.now();
    if (now - lastThrottleLogAt < 60_000) return;
    lastThrottleLogAt = now;
    logger.warn("chain.rpc_throttled", { label, status: 429 });
  };
  const toTransport = (url: string) => http(url, { onFetchResponse });
  return fallbackUrls?.length
    ? fallback([primaryUrl, ...fallbackUrls].map(toTransport))
    : toTransport(primaryUrl);
}

export interface ViemReaderOptions {
  rpcUrl: string;
  // Ordered failover endpoints tried after rpcUrl fails. viem retries a
  // failed request on the next transport automatically; empty/unset keeps
  // the single-endpoint transport.
  rpcFallbackUrls?: string[];
  chainId: ChainId;
  // Canonical per-chain ERC-8004 IdentityRegistry (0x8004A…).
  identityRegistryAddress: Hex;
  // Daski AgentIndex proxy — verified wallet→agentId reverse lookup plus
  // delegated registerWithSig, the two gaps the canonical registry leaves.
  agentIndexAddress: Hex;
  providerRegistryAddress: Hex;
  serviceRegistryAddress: Hex;
  paymentRouterAddress: Hex;
  // X402 adapter that the facilitator submits the EIP-3009 settle call to.
  // The router PaymentSettled event is still emitted by the router itself.
  x402AdapterAddress: Hex;
  permitAdapterAddress?: Hex;
  approvalAdapterAddress?: Hex;
  validationRegistryAddress?: Hex;
  sanctionsOracleAddress: Hex;
  usdcAddress: Hex;
  usdcDomain: UsdcDomainConfig;
  facilitatorPrivateKey: Hex;
  // Applies to settlement, confirmation, and reputation writes.
  facilitatorMaxTransactionFeeWei: bigint;
  // EAS contract. On Base / Base Sepolia this is the canonical
  // 0x4200000000000000000000000000000000000021.
  easAddress: Hex;
  reputationStorageAddress: Hex;
  easConfirmationSchemaUid: Hex;
  easOutcomeSchemaUid: Hex;
  // Canonical ERC-8004 ReputationRegistry (0x8004B…). Optional; the
  // feedback preparation, submission, recovery, and revocation methods
  // throw when unset. The mirror module gates on config before calling.
  reputationRegistryAddress?: Hex;
}

function chainForId(chainId: ChainId) {
  return chainId === 8453 ? base : baseSepolia;
}

/** Compose the contract-specific viem adapters into the ChainReader API. */
export function createViemChainReader(opts: ViemReaderOptions): ChainReader {
  const chain = chainForId(opts.chainId);
  const transport = buildChainTransport(
    opts.rpcUrl,
    opts.rpcFallbackUrls,
    "payment",
  );
  const publicClient = createPublicClient({ chain, transport });

  const account = privateKeyToAccount(opts.facilitatorPrivateKey, {
    nonceManager,
  });
  const walletClient = createWalletClient({ account, chain, transport });

  const routerAddress = opts.paymentRouterAddress;
  const adapterAddress = opts.x402AdapterAddress;
  const usdcAddress = opts.usdcAddress;
  const reputationStorageAddress = opts.reputationStorageAddress;

  return {
    ...createIdentityMethods(publicClient, opts),

    async getPaymentRecord(
      paymentId: bigint,
    ): Promise<PaymentRouterRecord | null> {
      const raw = (await publicClient.readContract({
        address: routerAddress,
        abi: paymentRouterAbi,
        functionName: "getPayment",
        args: [paymentId],
      })) as {
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
      };
      return raw;
    },

    async authorizationUsed(authorizer: Hex, nonce: Hex) {
      return (await publicClient.readContract({
        address: usdcAddress,
        abi: usdcAbi,
        functionName: "authorizationState",
        args: [authorizer, nonce],
      })) as boolean;
    },

    async verifyReceiveAuthorization(input) {
      return publicClient.verifyTypedData({
        address: input.signer,
        domain: input.domain,
        types: input.types as any,
        primaryType: input.primaryType,
        message: input.message,
        signature: input.signature,
      });
    },

    ...createSettlementMethods({
      publicClient,
      walletClient,
      account,
      chain,
      adapterAddress,
      agentIndexAddress: opts.agentIndexAddress,
      paymentRouterAddress: routerAddress,
      usdcAddress,
      maxTransactionFeeWei: opts.facilitatorMaxTransactionFeeWei,
    }),

    ...createConfirmationMethods({
      publicClient,
      walletClient,
      account,
      chain,
      easAddress: opts.easAddress,
      maxTransactionFeeWei: opts.facilitatorMaxTransactionFeeWei,
    }),

    async getBlockNumber(): Promise<bigint> {
      return await publicClient.getBlockNumber();
    },

    async getSafeBlockNumber(): Promise<bigint> {
      const block = await publicClient.getBlock({ blockTag: "safe" });
      return block.number;
    },

    verifyDeploymentReadiness: createViemDeploymentReadiness(publicClient, {
      chainId: opts.chainId,
      identityRegistryAddress: opts.identityRegistryAddress,
      agentIndexAddress: opts.agentIndexAddress,
      providerRegistryAddress: opts.providerRegistryAddress,
      serviceRegistryAddress: opts.serviceRegistryAddress,
      paymentRouterAddress: opts.paymentRouterAddress,
      x402AdapterAddress: opts.x402AdapterAddress,
      permitAdapterAddress: opts.permitAdapterAddress,
      approvalAdapterAddress: opts.approvalAdapterAddress,
      validationRegistryAddress: opts.validationRegistryAddress,
      reputationRegistryAddress: opts.reputationRegistryAddress,
      reputationStorageAddress,
      sanctionsOracleAddress: opts.sanctionsOracleAddress,
      usdc: opts.usdcDomain,
      easAddress: opts.easAddress,
      easOutcomeSchemaUid: opts.easOutcomeSchemaUid,
      easConfirmationSchemaUid: opts.easConfirmationSchemaUid,
      facilitatorAddress: account.address,
    }),

    ...createViemEventReader(publicClient, {
      paymentRouterAddress: opts.paymentRouterAddress,
      reputationStorageAddress,
      easAddress: opts.easAddress,
      confirmationSchemaUid: opts.easConfirmationSchemaUid,
    }),

    ...createReputationReadMethods(publicClient, reputationStorageAddress),
    ...createFeedbackMethods({
      publicClient,
      walletClient,
      account,
      chain,
      reputationRegistryAddress: opts.reputationRegistryAddress,
      maxTransactionFeeWei: opts.facilitatorMaxTransactionFeeWei,
    }),
  };
}

export interface ViemProjectionReaderOptions {
  rpcUrl: string;
  rpcFallbackUrls?: string[];
  chainId: ChainId;
  paymentRouterAddress: Hex;
  reputationStorageAddress: Hex;
  easAddress: Hex;
  easConfirmationSchemaUid: Hex;
}

/**
 * A read-only reader carrying exactly what the chain-events indexer needs
 * (latest/safe block reads + the projection event reader) on its OWN transport.
 * Lets CHAIN_INDEXER_RPC_URL route the bulk getLogs polling through a
 * separate endpoint (e.g. public primary, keyed fallback) so the indexer
 * cannot spend the payment path's keyed budget or saturate its per-IP
 * allowance — the self-inflicted throttling the 2026-08-01 post-mortem
 * traced the rpc_unavailable flakes to.
 */
export function createViemProjectionReader(opts: ViemProjectionReaderOptions) {
  const chain = chainForId(opts.chainId);
  const transport = buildChainTransport(
    opts.rpcUrl,
    opts.rpcFallbackUrls,
    "indexer",
  );
  const publicClient = createPublicClient({ chain, transport });
  return {
    async getBlockNumber(): Promise<bigint> {
      return await publicClient.getBlockNumber();
    },
    async getSafeBlockNumber(): Promise<bigint> {
      const block = await publicClient.getBlock({ blockTag: "safe" });
      return block.number;
    },
    ...createViemEventReader(publicClient, {
      paymentRouterAddress: opts.paymentRouterAddress,
      reputationStorageAddress: opts.reputationStorageAddress,
      easAddress: opts.easAddress,
      confirmationSchemaUid: opts.easConfirmationSchemaUid,
    }),
  };
}
