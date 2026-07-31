import { parseAbi } from "viem";

export const oracleAbi = parseAbi([
  "function isSanctioned(address account) view returns (bool)",
]);

export const usdcAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

export const agentIndexAbi = parseAbi([
  "function getIdentityRegistry() view returns (address)",
  "function sanctionsOracle() view returns (address)",
]);

export const providerRegistryAbi = parseAbi([
  "function identity() view returns (address)",
  "function usdc() view returns (address)",
  "function sanctionsOracle() view returns (address)",
]);

export const serviceRegistryAbi = parseAbi([
  "function identity() view returns (address)",
  "function providerRegistry() view returns (address)",
  "function sanctionsOracle() view returns (address)",
]);

export const routerAbi = parseAbi([
  "function identity() view returns (address)",
  "function registry() view returns (address)",
  "function serviceRegistry() view returns (address)",
  "function reputationStorage() view returns (address)",
  "function sanctionsOracle() view returns (address)",
  "function isAdapter(address adapter) view returns (bool)",
  "function isAcceptedToken(address token) view returns (bool)",
  "function getTokenReputationConfig(address token) view returns (bool reputationEnabled, uint256 minimumReputationAmount)",
]);

export const adapterAbi = parseAbi([
  "function router() view returns (address)",
  "function agentIndex() view returns (address)",
  "function sanctionsOracle() view returns (address)",
]);

export const x402Abi = parseAbi([
  "function router() view returns (address)",
  "function agentIndex() view returns (address)",
  "function sanctionsOracle() view returns (address)",
  "function authorizedFacilitators(address facilitator) view returns (bool)",
  "function getFacilitatorCount() view returns (uint256)",
  "function getFacilitatorAt(uint256 index) view returns (address)",
]);

export const reputationAbi = parseAbi([
  "function paymentRouter() view returns (address)",
  "function eas() view returns (address)",
  "function outcomeSchema() view returns (bytes32)",
  "function confirmationSchema() view returns (bytes32)",
  "function isConfigured() view returns (bool)",
  "function sanctionsOracle() view returns (address)",
]);

export const validationAbi = parseAbi([
  "function getIdentityRegistry() view returns (address)",
  "function sanctionsOracle() view returns (address)",
]);
