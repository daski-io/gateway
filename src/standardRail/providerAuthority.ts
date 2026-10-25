import { createPublicClient, getAddress, zeroAddress, type Address, type Chain } from "viem";
import { identityRegistryAbi } from "../marketplace/abis.js";
import { withRpcFailover } from "../rpc/failover.js";
import { orderedRpcTransport } from "../rpc/orderedTransport.js";
import { rpcReadTransport } from "../rpc/readTransport.js";
import type { FinalityTag } from "../util/finalityTag.js";
import { logger } from "../util/logger.js";

/** The provider agent's current agent wallet in IdentityRegistry. */
export interface ProviderAgentWallets {
  agentWallet(providerAgentId: string): Promise<Address>;
}

/** No fallback: only a listing's committed keys sign for its orders. */
export const COMMITTED_KEYS_ONLY: ProviderAgentWallets = { agentWallet: async () => zeroAddress };

// A switched provider signs every read of an old order with its new wallet;
// a short cache keeps those reads off the chain without trusting a moved
// wallet for long.
const CACHE_MILLISECONDS = 60_000;
const MAXIMUM_ENTRIES = 256;

/**
 * Reads IdentityRegistry.getAgentWallet at the gateway's finality tag, the
 * read registry authority uses, through the evidence endpoints with failover.
 * Successful reads are cached for a minute per agent; failures are not.
 */
export class ChainProviderAgentWallets implements ProviderAgentWallets {
  private readonly clients;
  private readonly cache = new Map<string, { wallet: Address; until: number }>();
  private readonly inFlight = new Map<string, Promise<Address>>();

  constructor(private readonly args: {
    rpcUrls: readonly string[];
    chain: Chain;
    identityRegistry: Address;
    finalityTag: FinalityTag;
    maxPerMinute?: number;
  }) {
    this.clients = args.rpcUrls.map((url) => ({
      url,
      host: new URL(url).hostname,
      client: createPublicClient({
        chain: args.chain,
        transport: orderedRpcTransport(rpcReadTransport(url), { scope: url, maxPerMinute: args.maxPerMinute }),
      }),
    }));
  }

  agentWallet(providerAgentId: string): Promise<Address> {
    const cached = this.cache.get(providerAgentId);
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.wallet);
    const pending = this.inFlight.get(providerAgentId);
    if (pending) return pending;
    const loading = this.read(providerAgentId).then((wallet) => {
      if (this.cache.size >= MAXIMUM_ENTRIES) this.cache.clear();
      this.cache.set(providerAgentId, { wallet, until: Date.now() + CACHE_MILLISECONDS });
      return wallet;
    }).finally(() => this.inFlight.delete(providerAgentId));
    this.inFlight.set(providerAgentId, loading);
    return loading;
  }

  private read(providerAgentId: string): Promise<Address> {
    return withRpcFailover(this.clients, async ({ client }) => {
      const block = await client.getBlock({ blockTag: this.args.finalityTag });
      return getAddress(await client.readContract({
        address: this.args.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "getAgentWallet",
        args: [BigInt(providerAgentId)],
        blockNumber: block.number,
      }));
    }, {
      operation: "providerAuthority.agentWallet",
      onFallback: (detail) => {
        logger.warn("provider authority RPC fallback selected", detail);
      },
    });
  }
}

/**
 * Whether a provider signature on an order of this listing is the provider's.
 * A listing version commits the agent wallet it was registered with; after a
 * provider authority switch moves the agent wallet on chain, the provider signs
 * every order, old versions' included, with the new wallet. A signature by the
 * committed key is accepted without a chain read; any other signer only when it
 * is the listing's provider agent's current agent wallet. Read failures throw.
 */
export async function providerSignatureAccepted(args: {
  signer: Address;
  committedKey: string;
  providerAgentId: string;
  wallets: ProviderAgentWallets;
}): Promise<boolean> {
  const signer = getAddress(args.signer);
  if (signer === getAddress(args.committedKey)) return true;
  const wallet = await args.wallets.agentWallet(args.providerAgentId);
  return wallet !== zeroAddress && signer === getAddress(wallet);
}
