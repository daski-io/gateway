import { getAddress, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { ViemMarketplaceChainReader } from "../src/marketplace/reader.js";

const ADDRESS = getAddress("0x1111111111111111111111111111111111111111");
const SERVICE_ID = `0x${"22".repeat(32)}` as Hex;

function reader(finalityTag: "safe" | "finalized" = "finalized") {
  const instance = new ViemMarketplaceChainReader({
    finalityTag,
    marketplaceContracts: {
      identityRegistry: ADDRESS,
      agentIndex: ADDRESS,
      providerRegistry: ADDRESS,
      serviceRegistry: ADDRESS,
      validationRegistry: ADDRESS,
      reputationStorage: ADDRESS,
    },
  } as Config, ["https://rpc.example", "https://fallback.example"], baseSepolia);
  const getBlock = vi.fn(async ({ blockTag }: { blockTag: string }) => ({
    number: blockTag === "safe" ? 110n : 100n,
  }));
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "getProvider") {
      return { agentId: 7n, registrationTime: 1n, isActive: true };
    }
    if (functionName === "ownerOf" || functionName === "getAgentWallet") return ADDRESS;
    if (functionName === "tokenURI") return "data:application/json,{}";
    if (functionName === "getServiceCountByProvider") return 1n;
    if (functionName === "getServicesByProviderPaginated") return [SERVICE_ID];
    if (functionName === "getProviderStats") return [1n, 2n, 3n, 4n, 5n, 6n];
    if (functionName === "getService") {
      return {
        providerAgentId: 7n,
        serviceId: SERVICE_ID,
        serviceSlug: "service",
        version: "1.0.0",
        serviceURI: "https://example.com",
        serviceWallet: ADDRESS,
        createdAt: 1n,
        active: true,
      };
    }
    if (functionName === "getServiceStats") return [1n, 2n, 3n, 4n, 5n, 6n, 7n];
    throw new Error(`unexpected contract read: ${functionName}`);
  });
  const fallback = { getBlock: vi.fn(), readContract: vi.fn() };
  Object.assign(instance as unknown as { clients: unknown[] }, {
    clients: [
      { host: "rpc.example", client: { getBlock, readContract } },
      { host: "fallback.example", client: fallback },
    ],
  });
  return { instance, getBlock, readContract, fallback };
}

describe("marketplace reputation reads", () => {
  it("reads provider stats at safe while retaining finalized registry metadata", async () => {
    const { instance, getBlock, readContract, fallback } = reader();

    await expect(instance.getProvider(7n)).resolves.toMatchObject({
      agentId: "7",
      standardReputation: { transactions: "6", safeBlock: "110" },
    });

    expect(getBlock).toHaveBeenCalledWith({ blockTag: "finalized" });
    expect(getBlock).toHaveBeenCalledWith({ blockTag: "safe" });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "getProviderStats",
      blockNumber: 110n,
    }));
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "getProvider",
      blockNumber: 100n,
    }));
    expect(fallback.getBlock).not.toHaveBeenCalled();
    expect(fallback.readContract).not.toHaveBeenCalled();
  });

  it("observes the safe tag for registry reads under the testnet finality policy", async () => {
    const { instance, getBlock, readContract } = reader("safe");

    await expect(instance.getProvider(7n)).resolves.toMatchObject({
      agentId: "7",
      standardReputation: { transactions: "6", safeBlock: "110" },
    });

    expect(getBlock).not.toHaveBeenCalledWith({ blockTag: "finalized" });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "getProvider",
      blockNumber: 110n,
    }));
  });

  it("reads service stats at safe while retaining finalized registry metadata", async () => {
    const { instance, readContract, fallback } = reader();

    await expect(instance.getService(SERVICE_ID)).resolves.toMatchObject({
      serviceId: SERVICE_ID,
      standardReputation: { transactions: "7", safeBlock: "110" },
    });

    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "getServiceStats",
      blockNumber: 110n,
    }));
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "getService",
      blockNumber: 100n,
    }));
    expect(fallback.getBlock).not.toHaveBeenCalled();
    expect(fallback.readContract).not.toHaveBeenCalled();
  });
});
