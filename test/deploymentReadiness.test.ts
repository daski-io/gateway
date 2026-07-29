import { describe, expect, it } from "vitest";
import type {
  DeploymentReadinessClient,
  DeploymentReadinessOptions,
} from "../src/chain/deploymentReadinessTypes.js";
import { createViemDeploymentReadiness } from "../src/chain/viemDeploymentReadiness.js";
import type { Hex } from "../src/types.js";

const address = (suffix: number): Hex =>
  `0x${suffix.toString(16).padStart(40, "0")}` as Hex;

const options: DeploymentReadinessOptions = {
  chainId: 8453,
  identityRegistryAddress: address(1),
  agentIndexAddress: address(2),
  providerRegistryAddress: address(3),
  serviceRegistryAddress: address(4),
  paymentRouterAddress: address(5),
  x402AdapterAddress: address(6),
  permitAdapterAddress: address(7),
  approvalAdapterAddress: address(8),
  validationRegistryAddress: address(9),
  reputationRegistryAddress: address(10),
  reputationStorageAddress: address(11),
  sanctionsOracleAddress: address(12),
  usdcAddress: address(13),
  easAddress: address(14),
  easOutcomeSchemaUid: `0x${"aa".repeat(32)}`,
  easConfirmationSchemaUid: `0x${"bb".repeat(32)}`,
  facilitatorAddress: address(15),
};

const key = (
  contract: Hex,
  functionName: string,
  args: readonly unknown[] = [],
) => `${contract}:${functionName}:${args.join(",")}`.toLowerCase();

class DeploymentFixture implements DeploymentReadinessClient {
  chainId = options.chainId;
  missingCode = new Set<string>();
  overrides = new Map<string, unknown>();

  async getChainId(): Promise<number> {
    return this.chainId;
  }

  async getBytecode(input: { address: Hex }): Promise<Hex | undefined> {
    return this.missingCode.has(input.address.toLowerCase())
      ? "0x"
      : "0x6000";
  }

  async readContract(input: {
    address: Hex;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown> {
    const lookup = key(input.address, input.functionName, input.args);
    if (this.overrides.has(lookup)) return this.overrides.get(lookup);
    return expectedRead(input.address, input.functionName, input.args);
  }

  set(
    contract: Hex,
    functionName: string,
    value: unknown,
    args?: readonly unknown[],
  ): void {
    this.overrides.set(key(contract, functionName, args), value);
  }
}

function expectedRead(
  contract: Hex,
  functionName: string,
  args: readonly unknown[] = [],
): unknown {
  const adapterAddresses = [
    options.x402AdapterAddress,
    options.permitAdapterAddress!,
    options.approvalAdapterAddress!,
  ];
  if (
    contract === options.sanctionsOracleAddress &&
    functionName === "isSanctioned"
  ) {
    return false;
  }
  const reads = new Map<string, unknown>([
    [key(options.agentIndexAddress, "getIdentityRegistry"), options.identityRegistryAddress],
    [key(options.agentIndexAddress, "sanctionsOracle"), options.sanctionsOracleAddress],
    [key(options.providerRegistryAddress, "identity"), options.identityRegistryAddress],
    [key(options.providerRegistryAddress, "usdc"), options.usdcAddress],
    [key(options.providerRegistryAddress, "sanctionsOracle"), options.sanctionsOracleAddress],
    [key(options.serviceRegistryAddress, "identity"), options.identityRegistryAddress],
    [key(options.serviceRegistryAddress, "providerRegistry"), options.providerRegistryAddress],
    [key(options.serviceRegistryAddress, "sanctionsOracle"), options.sanctionsOracleAddress],
    [key(options.paymentRouterAddress, "identity"), options.identityRegistryAddress],
    [key(options.paymentRouterAddress, "registry"), options.providerRegistryAddress],
    [key(options.paymentRouterAddress, "serviceRegistry"), options.serviceRegistryAddress],
    [key(options.paymentRouterAddress, "reputationStorage"), options.reputationStorageAddress],
    [key(options.paymentRouterAddress, "sanctionsOracle"), options.sanctionsOracleAddress],
    [key(options.paymentRouterAddress, "isAcceptedToken", [options.usdcAddress]), true],
    [key(options.paymentRouterAddress, "getTokenReputationConfig", [options.usdcAddress]), [true, 1n]],
    [key(options.x402AdapterAddress, "authorizedFacilitators", [options.facilitatorAddress]), true],
    [key(options.x402AdapterAddress, "getFacilitatorCount"), 1n],
    [key(options.x402AdapterAddress, "getFacilitatorAt", [0n]), options.facilitatorAddress],
    [key(options.reputationStorageAddress, "paymentRouter"), options.paymentRouterAddress],
    [key(options.reputationStorageAddress, "eas"), options.easAddress],
    [key(options.reputationStorageAddress, "outcomeSchema"), options.easOutcomeSchemaUid],
    [key(options.reputationStorageAddress, "confirmationSchema"), options.easConfirmationSchemaUid],
    [key(options.reputationStorageAddress, "sanctionsOracle"), options.sanctionsOracleAddress],
    [key(options.reputationStorageAddress, "isConfigured"), true],
    [key(options.validationRegistryAddress!, "getIdentityRegistry"), options.identityRegistryAddress],
    [key(options.validationRegistryAddress!, "sanctionsOracle"), options.sanctionsOracleAddress],
  ]);
  for (const adapter of adapterAddresses) {
    reads.set(key(adapter, "router"), options.paymentRouterAddress);
    reads.set(key(adapter, "agentIndex"), options.agentIndexAddress);
    reads.set(key(adapter, "sanctionsOracle"), options.sanctionsOracleAddress);
    reads.set(key(options.paymentRouterAddress, "isAdapter", [adapter]), true);
  }
  const value = reads.get(key(contract, functionName, args));
  if (value === undefined) {
    throw new Error(`unexpected read ${contract}.${functionName}`);
  }
  return value;
}

describe("live deployment readiness", () => {
  it("accepts the complete required and optional deployment graph", async () => {
    const verify = createViemDeploymentReadiness(
      new DeploymentFixture(),
      options,
    );
    await expect(verify()).resolves.toEqual({
      ready: true,
      failedCheck: null,
    });
  });

  it("fails closed on chain mismatch and missing bytecode", async () => {
    const wrongChain = new DeploymentFixture();
    wrongChain.chainId = 84532;
    await expect(
      createViemDeploymentReadiness(wrongChain, options)(),
    ).resolves.toMatchObject({ ready: false, failedCheck: "chain_id" });

    const missingCode = new DeploymentFixture();
    missingCode.missingCode.add(options.reputationStorageAddress);
    await expect(
      createViemDeploymentReadiness(missingCode, options)(),
    ).resolves.toMatchObject({
      ready: false,
      failedCheck: "reputation_storage_code",
    });
  });

  it.each([
    ["agent_index_identity", options.agentIndexAddress, "getIdentityRegistry"],
    ["agent_index_oracle", options.agentIndexAddress, "sanctionsOracle"],
    ["provider_registry_identity", options.providerRegistryAddress, "identity"],
    ["provider_registry_usdc", options.providerRegistryAddress, "usdc"],
    ["provider_registry_oracle", options.providerRegistryAddress, "sanctionsOracle"],
    ["service_registry_identity", options.serviceRegistryAddress, "identity"],
    ["service_registry_provider_registry", options.serviceRegistryAddress, "providerRegistry"],
    ["service_registry_oracle", options.serviceRegistryAddress, "sanctionsOracle"],
    ["payment_router_identity", options.paymentRouterAddress, "identity"],
    ["payment_router_provider_registry", options.paymentRouterAddress, "registry"],
    ["payment_router_service_registry", options.paymentRouterAddress, "serviceRegistry"],
    ["payment_router_reputation_storage", options.paymentRouterAddress, "reputationStorage"],
    ["payment_router_oracle", options.paymentRouterAddress, "sanctionsOracle"],
    ["x402_adapter_router", options.x402AdapterAddress, "router"],
    ["x402_adapter_agent_index", options.x402AdapterAddress, "agentIndex"],
    ["x402_adapter_oracle", options.x402AdapterAddress, "sanctionsOracle"],
    ["reputation_storage_router", options.reputationStorageAddress, "paymentRouter"],
    ["reputation_storage_eas", options.reputationStorageAddress, "eas"],
    ["reputation_storage_outcome_schema", options.reputationStorageAddress, "outcomeSchema"],
    ["reputation_storage_confirmation_schema", options.reputationStorageAddress, "confirmationSchema"],
    ["reputation_storage_oracle", options.reputationStorageAddress, "sanctionsOracle"],
    ["permit_adapter_router", options.permitAdapterAddress!, "router"],
    ["approval_adapter_agent_index", options.approvalAdapterAddress!, "agentIndex"],
    ["validation_registry_identity", options.validationRegistryAddress!, "getIdentityRegistry"],
    ["validation_registry_oracle", options.validationRegistryAddress!, "sanctionsOracle"],
  ])("reports %s independently", async (id, contract, functionName) => {
    const fixture = new DeploymentFixture();
    fixture.set(contract, functionName, address(999));
    await expect(
      createViemDeploymentReadiness(fixture, options)(),
    ).resolves.toMatchObject({ ready: false, failedCheck: id });
  });

  it.each([
    ["payment_router_x402_adapter", "isAdapter", options.x402AdapterAddress],
    ["payment_router_permit_adapter", "isAdapter", options.permitAdapterAddress],
    ["payment_router_approval_adapter", "isAdapter", options.approvalAdapterAddress],
    ["payment_router_usdc", "isAcceptedToken", options.usdcAddress],
  ])("fails when %s is unauthorized", async (id, functionName, target) => {
    const fixture = new DeploymentFixture();
    fixture.set(options.paymentRouterAddress, functionName, false, [target]);
    await expect(
      createViemDeploymentReadiness(fixture, options)(),
    ).resolves.toMatchObject({ ready: false, failedCheck: id });
  });

  it("fails for an unauthorized facilitator or disabled reputation", async () => {
    const facilitator = new DeploymentFixture();
    facilitator.set(
      options.x402AdapterAddress,
      "authorizedFacilitators",
      false,
      [options.facilitatorAddress],
    );
    await expect(
      createViemDeploymentReadiness(facilitator, options)(),
    ).resolves.toMatchObject({
      ready: false,
      failedCheck: "x402_facilitator",
    });

    const disabled = new DeploymentFixture();
    disabled.set(
      options.paymentRouterAddress,
      "getTokenReputationConfig",
      [false, 0n],
      [options.usdcAddress],
    );
    await expect(
      createViemDeploymentReadiness(disabled, options)(),
    ).resolves.toMatchObject({
      ready: false,
      failedCheck: "payment_router_usdc_reputation",
    });
  });

  it("fails for an extra or different facilitator", async () => {
    const extra = new DeploymentFixture();
    extra.set(options.x402AdapterAddress, "getFacilitatorCount", 2n);
    await expect(
      createViemDeploymentReadiness(extra, options)(),
    ).resolves.toMatchObject({
      ready: false,
      failedCheck: "x402_facilitator_count",
    });

    const different = new DeploymentFixture();
    different.set(
      options.x402AdapterAddress,
      "getFacilitatorAt",
      address(999),
      [0n],
    );
    await expect(
      createViemDeploymentReadiness(different, options)(),
    ).resolves.toMatchObject({
      ready: false,
      failedCheck: "x402_facilitator_set",
    });
  });

  it("fails when reputation storage is not finalized", async () => {
    const fixture = new DeploymentFixture();
    fixture.set(options.reputationStorageAddress, "isConfigured", false);
    await expect(
      createViemDeploymentReadiness(fixture, options)(),
    ).resolves.toMatchObject({
      ready: false,
      failedCheck: "reputation_storage_configured",
    });
  });

  it("maps provider errors to a stable non-leaking category", async () => {
    const fixture = new DeploymentFixture();
    fixture.set(
      options.agentIndexAddress,
      "getIdentityRegistry",
      Promise.reject(new Error("https://secret-rpc.example key=secret")),
    );
    await expect(
      createViemDeploymentReadiness(fixture, options)(),
    ).resolves.toEqual({
      ready: false,
      failedCheck: "rpc_unavailable",
    });
  });
});
