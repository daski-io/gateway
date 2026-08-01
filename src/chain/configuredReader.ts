import { AutoMockChainReader } from "./autoMockReader.js";
import type { ChainReader } from "./reader.js";
import {
  createViemChainReader,
  createViemProjectionReader,
} from "./viemReader.js";
import type { Config } from "../config.js";
import type { ProjectionReader } from "../indexer/chainEvents.js";

/**
 * Optional dedicated reader for the chain-events indexer. Built only when
 * CHAIN_INDEXER_RPC_URL is set AND the chain is live — under
 * CHAIN_MODE=mock the AutoMockChainReader stays the only reader (a live
 * transport there would defeat the mock's isolation). Returns undefined
 * when the indexer should share the main reader.
 */
export function createConfiguredProjectionReader(
  config: Config,
): ProjectionReader | undefined {
  if (config.chainMode === "mock") return undefined;
  if (!config.chainIndexerRpcUrl) return undefined;
  if (!config.reputationStorageAddress) return undefined;
  return createViemProjectionReader({
    rpcUrl: config.chainIndexerRpcUrl,
    rpcFallbackUrls: config.chainIndexerRpcFallbackUrls,
    chainId: config.chainId,
    paymentRouterAddress: config.paymentRouterAddress,
    reputationStorageAddress: config.reputationStorageAddress,
    easAddress: config.easAddress,
    easConfirmationSchemaUid: config.easConfirmationSchemaUid,
  });
}

export function createConfiguredChainReader(config: Config): ChainReader {
  if (config.chainMode === "mock") {
    if (config.chainId === 8453) {
      throw new Error("Base mainnet cannot use AutoMockChainReader");
    }
    return new AutoMockChainReader({
      tokenAddress: config.usdc.address,
      providerWalletAddress: config.mockProviderWalletAddress,
      providerAgentId: config.mockProviderAgentId,
      providerAgentUri: config.mockProviderAgentUri,
      defaultBuyerAgentId: config.mockBuyerAgentId,
    });
  }
  if (!config.reputationStorageAddress) {
    throw new Error("live chain mode requires ReputationStorage");
  }
  return createViemChainReader({
    rpcUrl: config.baseRpcUrl,
    rpcFallbackUrls: config.baseRpcFallbackUrls,
    chainId: config.chainId,
    identityRegistryAddress: config.identityRegistryAddress,
    agentIndexAddress: config.agentIndexAddress,
    providerRegistryAddress: config.providerRegistryAddress,
    serviceRegistryAddress: config.serviceRegistryAddress,
    paymentRouterAddress: config.paymentRouterAddress,
    x402AdapterAddress: config.x402AdapterAddress,
    permitAdapterAddress: config.permitAdapterAddress,
    approvalAdapterAddress: config.approvalAdapterAddress,
    validationRegistryAddress: config.validationRegistryAddress,
    sanctionsOracleAddress: config.sanctionsOracleAddress,
    usdcAddress: config.usdc.address,
    usdcDomain: config.usdc,
    facilitatorPrivateKey: config.facilitatorPrivateKey,
    facilitatorMaxTransactionFeeWei: config.facilitatorMaxTransactionFeeWei,
    easAddress: config.easAddress,
    reputationStorageAddress: config.reputationStorageAddress,
    easConfirmationSchemaUid: config.easConfirmationSchemaUid,
    easOutcomeSchemaUid: config.easOutcomeSchemaUid,
    reputationRegistryAddress: config.reputationRegistryAddress,
  });
}
