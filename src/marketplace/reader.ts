import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import type { Config } from "../config.js";
import { withRpcFailover } from "../rpc/failover.js";
import { logger } from "../util/logger.js";
import { orderedRpcTransport } from "../rpc/orderedTransport.js";
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
  getService(serviceId: Hex): Promise<MarketplaceServiceRecord>;
}

export interface MarketplaceServiceRecord {
  providerAgentId: string;
  serviceId: Hex;
  serviceSlug: string;
  version: string;
  serviceUri: string;
  serviceWallet: Address;
  createdAt: string;
  active: boolean;
  standardReputation: ReturnType<typeof serviceStats> & { safeBlock: string };
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
  private readonly clients;
  // Registry reads observe the configured finality tag (testnet `safe`,
  // mainnet `finalized`); reputation reads stay on `safe` everywhere.
  private readonly finalityTag: "safe" | "finalized";

  constructor(
    config: Pick<Config, "marketplaceContracts" | "finalityTag">,
    rpcUrls: readonly [string, ...string[]],
    chain: Chain,
  ) {
    this.finalityTag = config.finalityTag;
    this.addresses = Object.fromEntries(
      Object.entries(config.marketplaceContracts).map(([key, value]) => [key, getAddress(value)]),
    ) as unknown as MarketplaceAddresses;
    // Registry reads refresh caches off the request path, so each selected
    // endpoint serializes its calls while explicit failover owns whole-read retries.
    this.clients = rpcUrls.map((url) => ({
      host: new URL(url).hostname,
      client: createPublicClient({
        chain,
        transport: orderedRpcTransport(http(url, {
          retryCount: 0,
          timeout: 20_000,
        })),
      }),
    }));
  }

  private observe<Result>(
    work: (endpoint: (typeof this.clients)[number]) => Promise<Result>,
  ): Promise<Result> {
    return withRpcFailover(this.clients, work, {
      onFallback: ({ primaryHost, selectedHost }) => {
        logger.warn("marketplace RPC fallback selected", {
          primaryHost,
          selectedHost,
        });
      },
    });
  }

  async resolveWallet(wallet: Address): Promise<{ agentId: string; found: boolean }> {
    const [agentId, found] = await this.observe(({ client }) => client.readContract({
      address: this.addresses.agentIndex,
      abi: agentIndexAbi,
      functionName: "resolve",
      args: [wallet],
    }));
    return { agentId: agentId.toString(), found };
  }

  private async getIdentity(
    client: (typeof this.clients)[number]["client"],
    agentId: bigint,
    blockNumber: bigint,
  ) {
    const [owner, agentWallet, agentUri] = await Promise.all([
      client.readContract({
        address: this.addresses.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [agentId],
        blockNumber,
      }),
      client.readContract({
        address: this.addresses.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "getAgentWallet",
        args: [agentId],
        blockNumber,
      }),
      client.readContract({
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
    return this.observe(async ({ client }) => {
      const blockNumber = (await client.getBlock({ blockTag: this.finalityTag })).number;
      const [total, ids] = await Promise.all([
        client.readContract({
          address: this.addresses.providerRegistry,
          abi: providerRegistryAbi,
          functionName: "getProviderCount",
          blockNumber,
        }),
        client.readContract({
          address: this.addresses.providerRegistry,
          abi: providerRegistryAbi,
          functionName: "getProviderIdsPaginated",
          args: [BigInt(offset), BigInt(limit)],
          blockNumber,
        }),
      ]);
      const providers = await Promise.all(ids.map((agentId) =>
        this.providerSummary(client, agentId, blockNumber)));
      return { offset, limit, total: total.toString(), providers, finalizedBlock: blockNumber.toString() };
    });
  }

  private async providerSummary(
    client: (typeof this.clients)[number]["client"],
    agentId: bigint,
    blockNumber: bigint,
  ) {
    const [provider, agent] = await Promise.all([
      client.readContract({
        address: this.addresses.providerRegistry,
        abi: providerRegistryAbi,
        functionName: "getProvider",
        args: [agentId],
        blockNumber,
      }),
      this.getIdentity(client, agentId, blockNumber),
    ]);
    return {
      agentId: provider.agentId.toString(),
      registrationTime: provider.registrationTime.toString(),
      active: provider.isActive,
      identity: agent,
    };
  }

  async getProvider(agentId: bigint): Promise<unknown> {
    return this.observe(async ({ client }) => {
      const [finalizedBlock, safeBlock] = await Promise.all([
        client.getBlock({ blockTag: this.finalityTag }),
        client.getBlock({ blockTag: "safe" }),
      ]);
      const blockNumber = finalizedBlock.number;
      const [provider, serviceCount, serviceIds, reputation] = await Promise.all([
        this.providerSummary(client, agentId, blockNumber),
        client.readContract({
          address: this.addresses.serviceRegistry,
          abi: serviceRegistryAbi,
          functionName: "getServiceCountByProvider",
          args: [agentId],
          blockNumber,
        }),
        client.readContract({
          address: this.addresses.serviceRegistry,
          abi: serviceRegistryAbi,
          functionName: "getServicesByProviderPaginated",
          args: [agentId, 0n, 100n],
          blockNumber,
        }),
        client.readContract({
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
    });
  }

  async getService(serviceId: Hex): Promise<MarketplaceServiceRecord> {
    return this.observe(async ({ client }) => {
      const [finalizedBlock, safeBlock] = await Promise.all([
        client.getBlock({ blockTag: this.finalityTag }),
        client.getBlock({ blockTag: "safe" }),
      ]);
      const [service, reputation] = await Promise.all([
        client.readContract({
          address: this.addresses.serviceRegistry,
          abi: serviceRegistryAbi,
          functionName: "getService",
          args: [serviceId],
          blockNumber: finalizedBlock.number,
        }),
        client.readContract({
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
    });
  }
}
