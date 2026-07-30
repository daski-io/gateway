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
  | "getProviderAuthority"
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

    async getProviderAuthority(agentId: bigint, blockNumber: bigint) {
      const provider = await publicClient.readContract({
        address: addresses.providerRegistryAddress,
        abi: providerRegistryAbi,
        functionName: "getProvider",
        args: [agentId],
        blockNumber,
      });
      const record = provider as {
        agentId: bigint;
        registrationTime: bigint;
        isActive: boolean;
      };
      if (!record.isActive) {
        return {
          agentId,
          registrationTime: record.registrationTime,
          isActive: false,
          agentURI: "",
          walletAddress: `0x${"00".repeat(20)}` as Hex,
          observedBlock: blockNumber,
        };
      }
      const [agentURI, walletAddress] = await Promise.all([
        publicClient.readContract({
          address: addresses.identityRegistryAddress,
          abi: identityRegistryAbi,
          functionName: "tokenURI",
          args: [agentId],
          blockNumber,
        }),
        publicClient.readContract({
          address: addresses.identityRegistryAddress,
          abi: identityRegistryAbi,
          functionName: "getAgentWallet",
          args: [agentId],
          blockNumber,
        }),
      ]);
      return {
        agentId: record.agentId,
        registrationTime: record.registrationTime,
        isActive: record.isActive,
        agentURI: agentURI as string,
        walletAddress: walletAddress as Hex,
        observedBlock: blockNumber,
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
      const [agentId] = (await publicClient.readContract({
        address: addresses.agentIndexAddress,
        abi: agentIndexAbi,
        functionName: "resolve",
        args: [wallet],
      })) as readonly [bigint, boolean];
      return agentId;
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
