import { parseAbi } from "viem";

export const agentIndexAbi = parseAbi([
  "function resolve(address wallet) view returns (uint256 agentId,bool found)",
]);

export const identityRegistryAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

export const providerRegistryAbi = parseAbi([
  "function getProvider(uint256 agentId) view returns ((uint256 agentId,uint256 registrationTime,bool isActive))",
  "function getProviderCount() view returns (uint256)",
  "function getProviderIdsPaginated(uint256 offset,uint256 limit) view returns (uint256[] page)",
]);

export const serviceRegistryAbi = parseAbi([
  "function getService(bytes32 serviceId) view returns ((uint256 providerAgentId,bytes32 serviceId,string serviceSlug,string version,string serviceURI,address serviceWallet,address serviceWalletOwner,address serviceWalletAgentWallet,uint64 createdAt,bool active))",
  "function getServicesByProviderPaginated(uint256 providerAgentId,uint256 offset,uint256 limit) view returns (bytes32[] page)",
  "function getServiceCountByProvider(uint256 providerAgentId) view returns (uint256)",
]);

export const historicalReputationAbi = parseAbi([
  "function getProviderStats(uint256 id) view returns (uint256 completed,uint256 failed,uint256 canceled,uint256 confirmed,uint256 notConfirmed,uint256 transactions)",
  "function getServiceStats(bytes32 id) view returns (uint256 completed,uint256 failed,uint256 canceled,uint256 confirmed,uint256 notConfirmed,uint256 refundedAmount,uint256 transactions)",
]);
