import type { Hex } from "../types.js";
import {
  adapterAbi,
  agentIndexAbi,
  oracleAbi,
  providerRegistryAbi,
  reputationAbi,
  routerAbi,
  serviceRegistryAbi,
  usdcAbi,
  validationAbi,
  x402Abi,
} from "./deploymentReadinessAbis.js";
import type {
  DeploymentReadinessClient,
  DeploymentReadinessOptions,
  DeploymentReadinessResult,
} from "./deploymentReadinessTypes.js";

const PROBE_ACCOUNT = "0x0000000000000000000000000000000000000000";

interface AddressCheck {
  id: string;
  address: Hex;
  abi: readonly unknown[];
  functionName: string;
  expected: Hex;
}

interface BooleanCheck {
  id: string;
  address: Hex;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

const failed = (failedCheck: string): DeploymentReadinessResult => ({
  ready: false,
  failedCheck,
});

function sameHex(actual: unknown, expected: Hex): boolean {
  return (
    typeof actual === "string" &&
    actual.toLowerCase() === expected.toLowerCase()
  );
}

export function createViemDeploymentReadiness(
  client: DeploymentReadinessClient,
  options: DeploymentReadinessOptions,
) {
  const read = (
    address: Hex,
    abi: readonly unknown[],
    functionName: string,
    args?: readonly unknown[],
  ) => client.readContract({ address, abi, functionName, args });

  // Deployed bytecode and the USDC token constants are immutable for the
  // life of the process (a new deployment means new addresses and a new
  // boot). Re-reading them on every TTL refresh burned 13+ calls per
  // probe — most of the eth_getCode traffic in the 2026-08-01 post-mortem
  // — and stretched the cold /purchase readiness check past 5s. Verify
  // them until they pass once, then trust them; every dynamic fact
  // (chain id — a fallback transport could silently point elsewhere —
  // pause flags, facilitator set, router config) stays per-refresh.
  let immutableChecksVerified = false;

  return async function verifyDeploymentReadiness(): Promise<DeploymentReadinessResult> {
    try {
      if ((await client.getChainId()) !== options.chainId) {
        return failed("chain_id");
      }

      if (!immutableChecksVerified) {
        for (const [id, address] of contractCodeChecks(options)) {
          const bytecode = await client.getBytecode({ address });
          if (!bytecode || bytecode === "0x") return failed(id);
        }

        const usdcChecks = [
          ["usdc_decimals", "decimals", options.usdc.decimals],
          ["usdc_name", "name", options.usdc.name],
          ["usdc_version", "version", options.usdc.version],
          [
            "usdc_domain_separator",
            "DOMAIN_SEPARATOR",
            options.usdc.domainSeparator,
          ],
        ] as const;
        for (const [id, functionName, expected] of usdcChecks) {
          const actual = await read(
            options.usdc.address,
            usdcAbi,
            functionName,
          );
          const matches =
            typeof expected === "string" && expected.startsWith("0x")
              ? sameHex(actual, expected as Hex)
              : actual === expected;
          if (!matches) return failed(id);
        }
        immutableChecksVerified = true;
      }

      if (
        typeof (await read(
          options.sanctionsOracleAddress,
          oracleAbi,
          "isSanctioned",
          [PROBE_ACCOUNT],
        )) !== "boolean"
      ) {
        return failed("sanctions_oracle_probe");
      }

      for (const check of addressChecks(options)) {
        const actual = await read(
          check.address,
          check.abi,
          check.functionName,
        );
        if (!sameHex(actual, check.expected)) return failed(check.id);
      }

      for (const check of booleanChecks(options)) {
        const value = await read(
          check.address,
          check.abi,
          check.functionName,
          check.args,
        );
        if (value !== true) return failed(check.id);
      }

      const facilitatorCount = await read(
        options.x402AdapterAddress,
        x402Abi,
        "getFacilitatorCount",
      );
      if (facilitatorCount !== 1n) {
        return failed("x402_facilitator_count");
      }
      const facilitator = await read(
        options.x402AdapterAddress,
        x402Abi,
        "getFacilitatorAt",
        [0n],
      );
      if (!sameHex(facilitator, options.facilitatorAddress)) {
        return failed("x402_facilitator_set");
      }

      const reputationConfig = await read(
        options.paymentRouterAddress,
        routerAbi,
        "getTokenReputationConfig",
        [options.usdc.address],
      );
      if (
        !Array.isArray(reputationConfig) ||
        reputationConfig[0] !== true
      ) {
        return failed("payment_router_usdc_reputation");
      }
      return { ready: true, failedCheck: null };
    } catch {
      return failed("rpc_unavailable");
    }
  };
}

function contractCodeChecks(
  options: DeploymentReadinessOptions,
): Array<[string, Hex]> {
  return [
    ["identity_registry_code", options.identityRegistryAddress],
    ["agent_index_code", options.agentIndexAddress],
    ["provider_registry_code", options.providerRegistryAddress],
    ["service_registry_code", options.serviceRegistryAddress],
    ["payment_router_code", options.paymentRouterAddress],
    ["x402_adapter_code", options.x402AdapterAddress],
    ["usdc_code", options.usdc.address],
    ["eas_code", options.easAddress],
    ["reputation_storage_code", options.reputationStorageAddress],
    ["sanctions_oracle_code", options.sanctionsOracleAddress],
    ...(options.permitAdapterAddress
      ? [["permit_adapter_code", options.permitAdapterAddress] as [string, Hex]]
      : []),
    ...(options.approvalAdapterAddress
      ? [["approval_adapter_code", options.approvalAdapterAddress] as [string, Hex]]
      : []),
    ...(options.validationRegistryAddress
      ? [["validation_registry_code", options.validationRegistryAddress] as [string, Hex]]
      : []),
    ...(options.reputationRegistryAddress
      ? [["reputation_registry_code", options.reputationRegistryAddress] as [string, Hex]]
      : []),
  ];
}

function addressChecks(options: DeploymentReadinessOptions): AddressCheck[] {
  const check = (
    id: string,
    address: Hex,
    abi: readonly unknown[],
    functionName: string,
    expected: Hex,
  ): AddressCheck => ({ id, address, abi, functionName, expected });
  const oracle = options.sanctionsOracleAddress;
  const checks = [
    check("agent_index_identity", options.agentIndexAddress, agentIndexAbi, "getIdentityRegistry", options.identityRegistryAddress),
    check("agent_index_oracle", options.agentIndexAddress, agentIndexAbi, "sanctionsOracle", oracle),
    check("provider_registry_identity", options.providerRegistryAddress, providerRegistryAbi, "identity", options.identityRegistryAddress),
    check("provider_registry_usdc", options.providerRegistryAddress, providerRegistryAbi, "usdc", options.usdc.address),
    check("provider_registry_oracle", options.providerRegistryAddress, providerRegistryAbi, "sanctionsOracle", oracle),
    check("service_registry_identity", options.serviceRegistryAddress, serviceRegistryAbi, "identity", options.identityRegistryAddress),
    check("service_registry_provider_registry", options.serviceRegistryAddress, serviceRegistryAbi, "providerRegistry", options.providerRegistryAddress),
    check("service_registry_oracle", options.serviceRegistryAddress, serviceRegistryAbi, "sanctionsOracle", oracle),
    check("payment_router_identity", options.paymentRouterAddress, routerAbi, "identity", options.identityRegistryAddress),
    check("payment_router_provider_registry", options.paymentRouterAddress, routerAbi, "registry", options.providerRegistryAddress),
    check("payment_router_service_registry", options.paymentRouterAddress, routerAbi, "serviceRegistry", options.serviceRegistryAddress),
    check("payment_router_reputation_storage", options.paymentRouterAddress, routerAbi, "reputationStorage", options.reputationStorageAddress),
    check("payment_router_oracle", options.paymentRouterAddress, routerAbi, "sanctionsOracle", oracle),
    ...adapterAddressChecks("x402_adapter", options.x402AdapterAddress, x402Abi, options),
    check("reputation_storage_router", options.reputationStorageAddress, reputationAbi, "paymentRouter", options.paymentRouterAddress),
    check("reputation_storage_eas", options.reputationStorageAddress, reputationAbi, "eas", options.easAddress),
    check("reputation_storage_outcome_schema", options.reputationStorageAddress, reputationAbi, "outcomeSchema", options.easOutcomeSchemaUid),
    check("reputation_storage_confirmation_schema", options.reputationStorageAddress, reputationAbi, "confirmationSchema", options.easConfirmationSchemaUid),
    check("reputation_storage_oracle", options.reputationStorageAddress, reputationAbi, "sanctionsOracle", oracle),
  ];
  if (options.permitAdapterAddress) {
    checks.push(
      ...adapterAddressChecks("permit_adapter", options.permitAdapterAddress, adapterAbi, options),
    );
  }
  if (options.approvalAdapterAddress) {
    checks.push(
      ...adapterAddressChecks("approval_adapter", options.approvalAdapterAddress, adapterAbi, options),
    );
  }
  if (options.validationRegistryAddress) {
    checks.push(
      check("validation_registry_identity", options.validationRegistryAddress, validationAbi, "getIdentityRegistry", options.identityRegistryAddress),
      check("validation_registry_oracle", options.validationRegistryAddress, validationAbi, "sanctionsOracle", oracle),
    );
  }
  return checks;
}

function adapterAddressChecks(
  prefix: string,
  address: Hex,
  abi: readonly unknown[],
  options: DeploymentReadinessOptions,
): AddressCheck[] {
  return [
    { id: `${prefix}_router`, address, abi, functionName: "router", expected: options.paymentRouterAddress },
    { id: `${prefix}_agent_index`, address, abi, functionName: "agentIndex", expected: options.agentIndexAddress },
    { id: `${prefix}_oracle`, address, abi, functionName: "sanctionsOracle", expected: options.sanctionsOracleAddress },
  ];
}

function booleanChecks(options: DeploymentReadinessOptions): BooleanCheck[] {
  const adapterChecks: BooleanCheck[] = [
    {
      id: "payment_router_x402_adapter",
      address: options.paymentRouterAddress,
      abi: routerAbi,
      functionName: "isAdapter",
      args: [options.x402AdapterAddress],
    },
  ];
  for (const [id, address] of [
    ["payment_router_permit_adapter", options.permitAdapterAddress],
    ["payment_router_approval_adapter", options.approvalAdapterAddress],
  ] as const) {
    if (address) {
      adapterChecks.push({
        id,
        address: options.paymentRouterAddress,
        abi: routerAbi,
        functionName: "isAdapter",
        args: [address],
      });
    }
  }
  return [
    ...adapterChecks,
    { id: "payment_router_usdc", address: options.paymentRouterAddress, abi: routerAbi, functionName: "isAcceptedToken", args: [options.usdc.address] },
    { id: "x402_facilitator", address: options.x402AdapterAddress, abi: x402Abi, functionName: "authorizedFacilitators", args: [options.facilitatorAddress] },
    { id: "reputation_storage_configured", address: options.reputationStorageAddress, abi: reputationAbi, functionName: "isConfigured" },
  ];
}
