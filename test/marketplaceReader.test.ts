import express from "express";
import type { Server } from "node:http";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  getAddress,
  parseAbi,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { reputationStorageAbi } from "../src/marketplace/abis.js";
import { CachedMarketplaceChainReader } from "../src/marketplace/cachedReader.js";
import { ViemMarketplaceChainReader, type MarketplaceChainReader } from "../src/marketplace/reader.js";
import { createMarketplaceRouter } from "../src/marketplace/routes.js";

const ADDRESS = getAddress("0x1111111111111111111111111111111111111111");
const SERVICE_ID = `0x${"22".repeat(32)}` as Hex;

type ContractCall = { address?: string; functionName: string; args?: readonly unknown[] };
type RecoveryBatch = (contracts: readonly ContractCall[]) => Promise<unknown[]>;

// What the reputation contract answers to the recovered-figure batch, in the
// shape viem's multicall reports with allowFailure: an Error is a failed call.
function recoveryAnswers(options: { version?: unknown; count?: unknown } = {}): RecoveryBatch {
  const version = "version" in options ? options.version : "2.2.0";
  return async (contracts) => contracts.map(({ functionName }) => {
    const value = functionName === "version"
      ? version
      : "count" in options ? options.count : functionName === "recoveredCount" ? 3n : 2n;
    return value instanceof Error
      ? { status: "failure", error: value }
      : { status: "success", result: value };
  });
}

function reader(
  finalityTag: "safe" | "finalized" = "finalized",
  recoveryBatch: RecoveryBatch = recoveryAnswers(),
) {
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
  const multicall = vi.fn(async ({ contracts }: { contracts: readonly ContractCall[] }) =>
    recoveryBatch(contracts));
  const fallback = {
    getBlock: vi.fn(),
    readContract: vi.fn(),
    multicall: vi.fn(async () => { throw new Error("fallback unreachable"); }),
  };
  Object.assign(instance as unknown as { clients: unknown[] }, {
    clients: [
      { host: "rpc.example", client: { getBlock, readContract, multicall } },
      { host: "fallback.example", client: fallback },
    ],
  });
  return { instance, getBlock, readContract, multicall, fallback };
}

const PROVIDER_STATS = {
  completed: "1",
  failed: "2",
  canceled: "3",
  confirmed: "4",
  notConfirmed: "5",
  transactions: "6",
};
const SERVICE_STATS = {
  completed: "1",
  failed: "2",
  canceled: "3",
  confirmed: "4",
  notConfirmed: "5",
  refundedAmount: "6",
  transactions: "7",
};

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


const PROVIDER_RECORD = {
  agentId: "7",
  registrationTime: "1",
  active: true,
  identity: { owner: ADDRESS, agentWallet: ADDRESS, agentUri: "data:application/json,{}" },
  serviceCount: "1",
  serviceIds: [SERVICE_ID],
};
const SERVICE_RECORD = {
  providerAgentId: "7",
  serviceId: SERVICE_ID,
  serviceSlug: "service",
  version: "1.0.0",
  serviceUri: "https://example.com",
  serviceWallet: ADDRESS,
  createdAt: "1",
  active: true,
};

describe("recovered order figures", () => {
  it("leaves the registry reads exactly as they were, without a recovered read", async () => {
    const { instance, getBlock, readContract, multicall, fallback } = reader();

    await expect(instance.getProvider(7n)).resolves.toEqual({
      ...PROVIDER_RECORD,
      standardReputation: { ...PROVIDER_STATS, safeBlock: "110" },
    });
    await expect(instance.getService(SERVICE_ID)).resolves.toEqual({
      ...SERVICE_RECORD,
      standardReputation: { ...SERVICE_STATS, safeBlock: "110" },
    });

    // Registration, authority and checkout depend on these reads: the same
    // blocks and contract reads as ever, and no recovered figure.
    expect(getBlock).toHaveBeenCalledTimes(4);
    expect(readContract.mock.calls.map(([call]) => call.functionName).sort()).toEqual([
      "getAgentWallet",
      "getProvider",
      "getProviderStats",
      "getService",
      "getServiceCountByProvider",
      "getServiceStats",
      "getServicesByProviderPaginated",
      "ownerOf",
      "tokenURI",
    ]);
    expect(multicall).not.toHaveBeenCalled();
    expect(fallback.multicall).not.toHaveBeenCalled();
  });

  it("reads a recovered counter with the contract version at the given safe block", async () => {
    const { instance, getBlock, readContract, multicall } = reader();

    await expect(instance.readRecovered({ kind: "provider", agentId: 7n }, 110n)).resolves.toBe("3");
    await expect(instance.readRecovered({ kind: "service", serviceId: SERVICE_ID }, 111n)).resolves.toBe("2");

    expect(multicall).toHaveBeenNthCalledWith(1, expect.objectContaining({
      blockNumber: 110n,
      allowFailure: true,
      contracts: [
        expect.objectContaining({ address: ADDRESS, functionName: "version" }),
        expect.objectContaining({ address: ADDRESS, functionName: "recoveredCount", args: [7n] }),
      ],
    }));
    expect(multicall).toHaveBeenNthCalledWith(2, expect.objectContaining({
      blockNumber: 111n,
      allowFailure: true,
      contracts: [
        expect.objectContaining({ address: ADDRESS, functionName: "version" }),
        expect.objectContaining({ address: ADDRESS, functionName: "recoveredByService", args: [SERVICE_ID] }),
      ],
    }));
    // One batch per figure and nothing else.
    expect(getBlock).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it.each(["2.1.0", "2.2", "unversioned"])("answers null where the contract version is %s", async (version) => {
    const { instance } = reader("finalized", recoveryAnswers({ version, count: 9n }));

    await expect(instance.readRecovered({ kind: "provider", agentId: 7n }, 110n)).resolves.toBeNull();
    await expect(instance.readRecovered({ kind: "service", serviceId: SERVICE_ID }, 110n)).resolves.toBeNull();
  });

  it.each([
    { label: "the counter read fails", batch: recoveryAnswers({ count: new Error("execution reverted") }) },
    { label: "the version read fails", batch: recoveryAnswers({ version: new Error("rpc offline") }) },
    { label: "the endpoint refuses the batch", batch: async () => { throw new Error("socket hang up"); } },
  ])("answers null when $label, after one attempt per endpoint", async ({ batch }) => {
    const { instance, multicall, fallback } = reader("finalized", batch);

    await expect(instance.readRecovered({ kind: "provider", agentId: 7n }, 110n)).resolves.toBeNull();

    expect(multicall).toHaveBeenCalledOnce();
    expect(fallback.multicall).toHaveBeenCalledOnce();
  });

  it("answers null at once when the recovered read reverts", async () => {
    const reverted = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({
        abi: reputationStorageAbi,
        functionName: "recoveredCount",
        data: encodeErrorResult({
          abi: parseAbi(["error Error(string message)"]),
          errorName: "Error",
          args: ["unavailable"],
        }),
      }),
      { abi: reputationStorageAbi, functionName: "recoveredCount", args: [7n], contractAddress: ADDRESS },
    );
    const { instance, multicall, fallback } = reader("finalized", recoveryAnswers({ count: reverted }));

    await expect(instance.readRecovered({ kind: "provider", agentId: 7n }, 110n)).resolves.toBeNull();
    expect(multicall).toHaveBeenCalledOnce();
    expect(fallback.multicall).not.toHaveBeenCalled();
  });

  it("caches a recovered figure per figure and safe block", async () => {
    const { instance, multicall } = reader();
    const cached = new CachedMarketplaceChainReader(instance);
    const provider = { kind: "provider", agentId: 7n } as const;

    await expect(cached.readRecovered(provider, 110n)).resolves.toBe("3");
    await expect(cached.readRecovered(provider, 110n)).resolves.toBe("3");
    expect(multicall).toHaveBeenCalledOnce();

    // Another safe block or the service figure is an entry of its own.
    await expect(cached.readRecovered(provider, 111n)).resolves.toBe("3");
    await expect(cached.readRecovered({ kind: "service", serviceId: SERVICE_ID }, 110n)).resolves.toBe("2");
    expect(multicall).toHaveBeenCalledTimes(3);
  });
});

describe("recovered figures on the public registry reads", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  async function serve(chainReader: MarketplaceChainReader): Promise<string> {
    const app = express();
    app.use(createMarketplaceRouter(chainReader));
    server = await new Promise<Server>((resolve, reject) => {
      const created: Server = app.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve(created));
    });
    const details = server.address();
    if (!details || typeof details === "string") throw new Error("test listener unavailable");
    return `http://127.0.0.1:${details.port}`;
  }

  it.each([
    { label: "the recovered counters", batch: recoveryAnswers(), provider: "3", service: "2" },
    {
      label: "null where the contract predates recoveries",
      batch: recoveryAnswers({ version: "2.1.0", count: 9n }),
      provider: null,
      service: null,
    },
    {
      label: "null when the read fails",
      batch: async () => { throw new Error("socket hang up"); },
      provider: null,
      service: null,
    },
  ])("serve $label beside the unchanged registry records", async ({ batch, provider, service }) => {
    const { instance, multicall } = reader("finalized", batch);
    const baseUrl = await serve(new CachedMarketplaceChainReader(instance));

    const providerResponse = await fetch(`${baseUrl}/public/v2/registry/providers/7`);
    const serviceResponse = await fetch(`${baseUrl}/public/v2/registry/services/${SERVICE_ID}`);

    expect(providerResponse.status).toBe(200);
    expect(await providerResponse.json()).toEqual({
      ...PROVIDER_RECORD,
      standardReputation: { ...PROVIDER_STATS, safeBlock: "110", recovered: provider },
    });
    expect(serviceResponse.status).toBe(200);
    expect(await serviceResponse.json()).toEqual({
      ...SERVICE_RECORD,
      standardReputation: { ...SERVICE_STATS, safeBlock: "110", recovered: service },
    });
    // Each figure is read at the safe block of the stats it joins.
    expect(multicall).toHaveBeenCalledTimes(2);
    for (const [call] of multicall.mock.calls) expect(call).toMatchObject({ blockNumber: 110n });
  });
});
