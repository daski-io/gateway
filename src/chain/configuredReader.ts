import { AutoMockChainReader } from "./autoMockReader.js";
import type { ChainReader } from "./reader.js";
import { createViemChainReader } from "./viemReader.js";
import type { Config } from "../config.js";

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
