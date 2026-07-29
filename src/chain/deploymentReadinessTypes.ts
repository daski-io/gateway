import type { Hex } from "../types.js";

export interface DeploymentReadinessOptions {
  chainId: number;
  identityRegistryAddress: Hex;
  agentIndexAddress: Hex;
  providerRegistryAddress: Hex;
  serviceRegistryAddress: Hex;
  paymentRouterAddress: Hex;
  x402AdapterAddress: Hex;
  permitAdapterAddress?: Hex;
  approvalAdapterAddress?: Hex;
  validationRegistryAddress?: Hex;
  reputationRegistryAddress?: Hex;
  reputationStorageAddress: Hex;
  sanctionsOracleAddress: Hex;
  usdcAddress: Hex;
  easAddress: Hex;
  easOutcomeSchemaUid: Hex;
  easConfirmationSchemaUid: Hex;
  facilitatorAddress: Hex;
}

export interface DeploymentReadinessClient {
  getChainId(): Promise<number>;
  getBytecode(input: { address: Hex }): Promise<Hex | undefined>;
  readContract(input: {
    address: Hex;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

export interface DeploymentReadinessResult {
  ready: boolean;
  failedCheck: string | null;
}
