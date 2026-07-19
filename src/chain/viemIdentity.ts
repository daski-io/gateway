import type { PublicClient, Transport } from "viem";
import type { base, baseSepolia } from "viem/chains";
import { agentIndexAbi, identityRegistryAbi, providerRegistryAbi } from "./abis.js";
import type { ChainReader } from "./reader.js";
import type { Hex } from "../types.js";

export interface IdentityContractAddresses {
  agentIndexAddress: Hex;
  identityRegistryAddress: Hex;
  providerRegistryAddress: Hex;
}

type IdentityMethods = Pick<
  ChainReader,
  | "getProviderCount"
  | "getProviderIdAt"
  | "getProvider"
  | "getAgentURI"
  | "agentOfWallet"
  | "getAgentWallet"
  | "getAgentOwner"
  | "getRegistrationNonce"
>;

export function createIdentityMethods(
  publicClient: PublicClient<Transport, typeof base | typeof baseSepolia>,
  addresses: IdentityContractAddresses,
): IdentityMethods {
  return {
    async getProviderCount() {
      return (await publicClient.readContract({
        address: addresses.providerRegistryAddress,
        abi: providerRegistryAbi,
        functionName: "getProviderCount",
      })) as bigint;
    },

    async getProviderIdAt(index: bigint) {
      return (await publicClient.readContract({
        address: addresses.providerRegistryAddress,
        abi: providerRegistryAbi,
        functionName: "providerIds",
        args: [index],
      })) as bigint;
    },

    async getProvider(agentId: bigint) {
      return (await publicClient.readContract({
        address: addresses.providerRegistryAddress,
        abi: providerRegistryAbi,
        functionName: "getProvider",
        args: [agentId],
      })) as {
        agentId: bigint;
        registrationTime: bigint;
        isActive: boolean;
      };
    },

    async getAgentURI(agentId: bigint) {
      return (await publicClient.readContract({
        address: addresses.identityRegistryAddress,
        abi: identityRegistryAbi,
        functionName: "tokenURI",
        args: [agentId],
      })) as string;
    },

    async agentOfWallet(wallet: Hex) {
      return (await publicClient.readContract({
        address: addresses.agentIndexAddress,
        abi: agentIndexAbi,
        functionName: "resolve",
        args: [wallet],
      })) as bigint;
    },

    async getAgentWallet(agentId: bigint) {
      return (await publicClient.readContract({
        address: addresses.identityRegistryAddress,
        abi: identityRegistryAbi,
        functionName: "getAgentWallet",
        args: [agentId],
      })) as Hex;
    },

    async getAgentOwner(agentId: bigint) {
      return (await publicClient.readContract({
        address: addresses.identityRegistryAddress,
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [agentId],
      })) as Hex;
    },

    async getRegistrationNonce(wallet: Hex) {
      return (await publicClient.readContract({
        address: addresses.agentIndexAddress,
        abi: agentIndexAbi,
        functionName: "registrationNonce",
        args: [wallet],
      })) as bigint;
    },
  };
}
