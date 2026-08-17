import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import type { Config } from "../config.js";
import type { StandardRailConfig } from "../standardRail/config.js";
import {
  agentIndexAbi,
  reputationStorageAbi,
  identityRegistryAbi,
  providerRegistryAbi,
  serviceRegistryAbi,
} from "./abis.js";

interface MarketplaceAddresses {
  identityRegistry: Address;
  agentIndex: Address;
  providerRegistry: Address;
  serviceRegistry: Address;
  validationRegistry: Address;
  reputationStorage: Address;
}

export interface MarketplaceChainReader {
  readonly addresses: MarketplaceAddresses;
  resolveWallet(wallet: Address): Promise<{ agentId: string; found: boolean }>;
  listProviders(offset: number, limit: number): Promise<unknown>;
  getProvider(agentId: bigint): Promise<unknown>;
  getService(serviceId: Hex): Promise<unknown>;
}

function identity(value: readonly [Address, Address, string]) {
  return { owner: value[0], agentWallet: value[1], agentUri: value[2] };
}

function providerStats(value: readonly [bigint, bigint, bigint, bigint, bigint, bigint]) {
  return {
    completed: value[0].toString(),
    failed: value[1].toString(),
    canceled: value[2].toString(),
    confirmed: value[3].toString(),
    notConfirmed: value[4].toString(),
    transactions: value[5].toString(),
  };
}

function serviceStats(value: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint]) {
  return {
    completed: value[0].toString(),
    failed: value[1].toString(),
    canceled: value[2].toString(),
    confirmed: value[3].toString(),
    notConfirmed: value[4].toString(),
    refundedAmount: value[5].toString(),
    transactions: value[6].toString(),
  };
}

export class ViemMarketplaceChainReader implements MarketplaceChainReader {
  readonly addresses: MarketplaceAddresses;
  private readonly client;

  constructor(config: Config, railConfig: StandardRailConfig, chain: Chain) {
    this.addresses = Object.fromEntries(
      Object.entries(config.marketplaceContracts).map(([key, value]) => [key, getAddress(value)]),
    ) as unknown as MarketplaceAddresses;
    this.client = createPublicClient({
      chain,
      transport: fallback(railConfig.evidenceRpcUrls.map((url) => http(url, {
        retryCount: 0,
        timeout: 20_000,
      }))),
    });
  }

  async resolveWallet(wallet: Address): Promise<{ agentId: string; found: boolean }> {
    const [agentId, found] = await this.client.readContract({
      address: this.addresses.agentIndex,
      abi: agentIndexAbi,
      functionName: "resolve",
      args: [wallet],
    });
    return { agentId: agentId.toString(), found };
  }

  private async getIdentity(agentId: bigint, blockNumber: bigint) {
    const [owner, agentWallet, agentUri] = await Promise.all([
      this.client.readContract({
        address: this.addresses.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [agentId],
        blockNumber,
      }),
      this.client.readContract({
        address: this.addresses.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "getAgentWallet",
        args: [agentId],
        blockNumber,
      }),
      this.client.readContract({
        address: this.addresses.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "tokenURI",
        args: [agentId],
        blockNumber,
      }),
    ]);
    return identity([owner, agentWallet, agentUri]);
  }

  async listProviders(offset: number, limit: number): Promise<unknown> {
    const blockNumber = (await this.client.getBlock({ blockTag: "finalized" })).number;
    const [total, ids] = await Promise.all([
      this.client.readContract({
        address: this.addresses.providerRegistry,
        abi: providerRegistryAbi,
        functionName: "getProviderCount",
        blockNumber,
      }),
      this.client.readContract({
        address: this.addresses.providerRegistry,
        abi: providerRegistryAbi,
        functionName: "getProviderIdsPaginated",
        args: [BigInt(offset), BigInt(limit)],
        blockNumber,
      }),
    ]);
    const providers = await Promise.all(ids.map((agentId) => this.providerSummary(agentId, blockNumber)));
    return { offset, limit, total: total.toString(), providers, finalizedBlock: blockNumber.toString() };
  }

  private async providerSummary(agentId: bigint, blockNumber: bigint) {
    const [provider, agent] = await Promise.all([
      this.client.readContract({
        address: this.addresses.providerRegistry,
        abi: providerRegistryAbi,
        functionName: "getProvider",
        args: [agentId],
        blockNumber,
      }),
      this.getIdentity(agentId, blockNumber),
    ]);
    return {
      agentId: provider.agentId.toString(),
      registrationTime: provider.registrationTime.toString(),
      active: provider.isActive,
      identity: agent,
    };
  }

  async getProvider(agentId: bigint): Promise<unknown> {
    const [finalizedBlock, safeBlock] = await Promise.all([
      this.client.getBlock({ blockTag: "finalized" }),
      this.client.getBlock({ blockTag: "safe" }),
    ]);
    const blockNumber = finalizedBlock.number;
    const [provider, serviceCount, serviceIds, reputation] = await Promise.all([
      this.providerSummary(agentId, blockNumber),
      this.client.readContract({
        address: this.addresses.serviceRegistry,
        abi: serviceRegistryAbi,
        functionName: "getServiceCountByProvider",
        args: [agentId],
        blockNumber,
      }),
      this.client.readContract({
        address: this.addresses.serviceRegistry,
        abi: serviceRegistryAbi,
        functionName: "getServicesByProviderPaginated",
        args: [agentId, 0n, 100n],
        blockNumber,
      }),
      this.client.readContract({
        address: this.addresses.reputationStorage,
        abi: reputationStorageAbi,
        functionName: "getProviderStats",
        args: [agentId],
        blockNumber: safeBlock.number,
      }),
    ]);
    return {
      ...provider as object,
      serviceCount: serviceCount.toString(),
      serviceIds,
      standardReputation: { ...providerStats(reputation), safeBlock: safeBlock.number.toString() },
    };
  }

  async getService(serviceId: Hex): Promise<unknown> {
    const [finalizedBlock, safeBlock] = await Promise.all([
      this.client.getBlock({ blockTag: "finalized" }),
      this.client.getBlock({ blockTag: "safe" }),
    ]);
    const [service, reputation] = await Promise.all([
      this.client.readContract({
        address: this.addresses.serviceRegistry,
        abi: serviceRegistryAbi,
        functionName: "getService",
        args: [serviceId],
        blockNumber: finalizedBlock.number,
      }),
      this.client.readContract({
        address: this.addresses.reputationStorage,
        abi: reputationStorageAbi,
        functionName: "getServiceStats",
        args: [serviceId],
        blockNumber: safeBlock.number,
      }),
    ]);
    return {
      providerAgentId: service.providerAgentId.toString(),
      serviceId: service.serviceId,
      serviceSlug: service.serviceSlug,
      version: service.version,
      serviceUri: service.serviceURI,
      serviceWallet: service.serviceWallet,
      createdAt: service.createdAt.toString(),
      active: service.active,
      standardReputation: { ...serviceStats(reputation), safeBlock: safeBlock.number.toString() },
    };
  }
}
