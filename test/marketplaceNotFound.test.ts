import type { McpServer } from "@modelcontextprotocol/server";
import express from "express";
import type { Server } from "node:http";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeErrorResult,
  getAddress,
  parseAbi,
  zeroHash,
  type Abi,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import {
  identityRegistryAbi,
  providerRegistryAbi,
  serviceRegistryAbi,
} from "../src/marketplace/abis.js";
import { CachedMarketplaceChainReader } from "../src/marketplace/cachedReader.js";
import { registerMarketplaceTools } from "../src/marketplace/mcp.js";
import {
  isContractRevert,
  MarketplaceNotFoundError,
  ViemMarketplaceChainReader,
  type MarketplaceChainReader,
} from "../src/marketplace/reader.js";
import { createMarketplaceRouter } from "../src/marketplace/routes.js";
import type { McpToolResult } from "../src/mcp/util.js";

const ADDRESS = getAddress("0x1111111111111111111111111111111111111111");
const SERVICE_ID = `0x${"22".repeat(32)}` as Hex;
const UNKNOWN_AGENT = 42n;

// ── viem error fixtures ──────────────────────────────────────────────────────
//
// These are the exact classes viem's readContract throws for an eth_call that
// reverted: a ContractFunctionExecutionError whose cause is the
// ContractFunctionRevertedError built from the node's revert data.

const solidityErrorAbi = parseAbi(["error Error(string message)"]);
const erc721ErrorAbi = parseAbi(["error ERC721NonexistentToken(uint256 tokenId)"]);

function requireRevertData(reason: string): Hex {
  return encodeErrorResult({ abi: solidityErrorAbi, errorName: "Error", args: [reason] });
}

function contractRevert(
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  revert: { data?: Hex; message?: string },
): ContractFunctionExecutionError {
  const reverted = new ContractFunctionRevertedError({ abi, functionName, ...revert });
  return new ContractFunctionExecutionError(reverted, {
    abi,
    functionName,
    args: [...args],
    contractAddress: ADDRESS,
  });
}

const unregisteredProvider = () => contractRevert(
  providerRegistryAbi,
  "getProvider",
  [UNKNOWN_AGENT],
  { data: requireRevertData("not registered") },
);
const missingIdentityToken = (functionName: "ownerOf" | "tokenURI") => contractRevert(
  identityRegistryAbi,
  functionName,
  [UNKNOWN_AGENT],
  {
    data: encodeErrorResult({
      abi: erc721ErrorAbi,
      errorName: "ERC721NonexistentToken",
      args: [UNKNOWN_AGENT],
    }),
  },
);
const unknownService = () => contractRevert(
  serviceRegistryAbi,
  "getService",
  [SERVICE_ID],
  { data: requireRevertData("service not found") },
);

describe("isContractRevert", () => {
  it("recognizes a require(...) revert with a reason string", () => {
    const error = unregisteredProvider();
    expect(error.cause).toBeInstanceOf(ContractFunctionRevertedError);
    expect((error.cause as ContractFunctionRevertedError).reason).toBe("not registered");
    expect(isContractRevert(error)).toBe(true);
  });

  it("recognizes a custom-error revert the ABI cannot decode", () => {
    const error = missingIdentityToken("ownerOf");
    expect((error.cause as ContractFunctionRevertedError).signature).toBe("0x7e273289");
    expect(isContractRevert(error)).toBe(true);
  });

  it("finds the revert deeper in the cause chain", () => {
    const inner = unregisteredProvider();
    const outer = new ContractFunctionExecutionError(inner, {
      abi: providerRegistryAbi,
      functionName: "getProvider",
      args: [UNKNOWN_AGENT],
    });
    expect(isContractRevert(outer)).toBe(true);
  });

  it("rejects a node fault that viem files as a revert without revert data", () => {
    // viem wraps a -32603 internal error as ContractFunctionRevertedError too,
    // carrying only the node's message; that is an outage, not an answer.
    expect(isContractRevert(contractRevert(
      providerRegistryAbi,
      "getProvider",
      [UNKNOWN_AGENT],
      { message: "internal error" },
    ))).toBe(false);
    expect(isContractRevert(contractRevert(
      providerRegistryAbi,
      "getProvider",
      [UNKNOWN_AGENT],
      { data: "0x", message: "execution reverted" },
    ))).toBe(false);
  });

  it("rejects transport faults, empty responses, and non-viem errors", () => {
    const transport = new ContractFunctionExecutionError(new BaseError("RPC Request failed."), {
      abi: providerRegistryAbi,
      functionName: "getProvider",
      args: [UNKNOWN_AGENT],
    });
    const noCode = new ContractFunctionExecutionError(
      new ContractFunctionZeroDataError({ functionName: "getProvider" }),
      { abi: providerRegistryAbi, functionName: "getProvider", args: [UNKNOWN_AGENT] },
    );
    expect(isContractRevert(transport)).toBe(false);
    expect(isContractRevert(noCode)).toBe(false);
    expect(isContractRevert(new Error("socket hang up"))).toBe(false);
    expect(isContractRevert(undefined)).toBe(false);
  });
});

// ── chain reader ─────────────────────────────────────────────────────────────

type ContractRead = (call: { functionName: string; args?: readonly unknown[] }) => Promise<unknown>;

function registeredProviderReads(call: { functionName: string }): unknown {
  switch (call.functionName) {
    case "getProvider": return { agentId: 7n, registrationTime: 1n, isActive: true };
    case "ownerOf":
    case "getAgentWallet": return ADDRESS;
    case "tokenURI": return "data:application/json,{}";
    case "getServiceCountByProvider": return 0n;
    case "getServicesByProviderPaginated": return [];
    case "getProviderStats": return [0n, 0n, 0n, 0n, 0n, 0n];
    case "getServiceStats": return [0n, 0n, 0n, 0n, 0n, 0n, 0n];
    default: throw new Error(`unexpected contract read: ${call.functionName}`);
  }
}

function chainReader(primaryRead: ContractRead) {
  const instance = new ViemMarketplaceChainReader({
    finalityTag: "safe",
    marketplaceContracts: {
      identityRegistry: ADDRESS,
      agentIndex: ADDRESS,
      providerRegistry: ADDRESS,
      serviceRegistry: ADDRESS,
      validationRegistry: ADDRESS,
      reputationStorage: ADDRESS,
    },
  } as Config, ["https://rpc.example", "https://fallback.example"], baseSepolia);
  const primary = {
    getBlock: vi.fn(async () => ({ number: 100n })),
    readContract: vi.fn(primaryRead),
  };
  const fallback = {
    getBlock: vi.fn(async () => ({ number: 100n })),
    readContract: vi.fn(async (call: { functionName: string }) => registeredProviderReads(call)),
  };
  Object.assign(instance as unknown as { clients: unknown[] }, {
    clients: [
      { host: "rpc.example", client: primary },
      { host: "fallback.example", client: fallback },
    ],
  });
  return { instance, primary, fallback };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => { throw new Error("expected the read to reject"); },
    (error: unknown) => error,
  );
}

describe("marketplace reader not-found answers", () => {
  it("answers an unregistered provider id once, without retries or failover", async () => {
    const { instance, primary, fallback } = chainReader(async (call) => {
      if (call.functionName === "getProvider") throw unregisteredProvider();
      if (call.functionName === "ownerOf" || call.functionName === "tokenURI") {
        throw missingIdentityToken(call.functionName);
      }
      return registeredProviderReads(call);
    });

    const error = await rejection(instance.getProvider(UNKNOWN_AGENT));

    expect(error).toBeInstanceOf(MarketplaceNotFoundError);
    expect(error).toMatchObject({
      name: "MarketplaceNotFoundError",
      kind: "provider",
      id: "42",
      message: "No provider is registered under id 42",
    });
    expect((error as MarketplaceNotFoundError).cause).toBeInstanceOf(ContractFunctionExecutionError);
    // One attempt reads the two block tags; a retry would read them again.
    expect(primary.getBlock).toHaveBeenCalledTimes(2);
    expect(fallback.getBlock).not.toHaveBeenCalled();
    expect(fallback.readContract).not.toHaveBeenCalled();
  });

  it("reports the provider registry's verdict even when the identity read settles first", async () => {
    const { instance } = chainReader(async (call) => {
      if (call.functionName === "getProvider") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw unregisteredProvider();
      }
      if (call.functionName === "ownerOf" || call.functionName === "tokenURI") {
        throw missingIdentityToken(call.functionName);
      }
      return registeredProviderReads(call);
    });

    await expect(instance.getProvider(UNKNOWN_AGENT)).rejects.toMatchObject({ kind: "provider", id: "42" });
  });

  it("answers a registered provider whose identity token is missing as an unknown agent", async () => {
    const { instance } = chainReader(async (call) => {
      if (call.functionName === "ownerOf" || call.functionName === "tokenURI") {
        throw missingIdentityToken(call.functionName);
      }
      return registeredProviderReads(call);
    });

    await expect(instance.getProvider(UNKNOWN_AGENT)).rejects.toMatchObject({
      kind: "agent",
      id: "42",
      message: "No ERC-8004 agent exists under id 42",
    });
  });

  it("answers an unknown service id once, without retries or failover", async () => {
    const { instance, primary, fallback } = chainReader(async (call) => {
      if (call.functionName === "getService") throw unknownService();
      return registeredProviderReads(call);
    });

    await expect(instance.getService(SERVICE_ID)).rejects.toMatchObject({
      kind: "service",
      id: SERVICE_ID,
      message: `No service is registered under id ${SERVICE_ID}`,
    });
    expect(primary.getBlock).toHaveBeenCalledTimes(2);
    expect(fallback.readContract).not.toHaveBeenCalled();
  });

  it("treats an empty service row as not found", async () => {
    const { instance } = chainReader(async (call) => {
      if (call.functionName === "getService") {
        return {
          providerAgentId: 0n,
          serviceId: zeroHash,
          serviceSlug: "",
          version: "",
          serviceURI: "",
          serviceWallet: "0x0000000000000000000000000000000000000000",
          createdAt: 0n,
          active: false,
        };
      }
      return registeredProviderReads(call);
    });

    await expect(instance.getService(SERVICE_ID)).rejects.toMatchObject({ kind: "service", id: SERVICE_ID });
  });

  it("keeps retrying and failing over for anything that is not a revert", async () => {
    vi.useFakeTimers();
    try {
      const { instance, primary, fallback } = chainReader(async () => {
        throw new Error("socket hang up");
      });

      const pending = instance.getProvider(7n);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toMatchObject({ agentId: "7" });
      expect(primary.getBlock).toHaveBeenCalledTimes(6);
      expect(fallback.readContract).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a not-found through the cache without storing it", async () => {
    const source = {
      addresses: {} as MarketplaceChainReader["addresses"],
      resolveWallet: vi.fn(),
      listProviders: vi.fn(),
      getProvider: vi.fn<MarketplaceChainReader["getProvider"]>()
        .mockRejectedValueOnce(new MarketplaceNotFoundError("provider", "42"))
        .mockResolvedValueOnce({ agentId: "42" }),
      getService: vi.fn(),
    };
    const cached = new CachedMarketplaceChainReader(source as unknown as MarketplaceChainReader);

    await expect(cached.getProvider(42n)).rejects.toBeInstanceOf(MarketplaceNotFoundError);
    await expect(cached.getProvider(42n)).resolves.toEqual({ agentId: "42" });
    expect(source.getProvider).toHaveBeenCalledTimes(2);
  });
});

// ── MCP and HTTP mappings ────────────────────────────────────────────────────

function stubReader(overrides: Partial<MarketplaceChainReader>): MarketplaceChainReader {
  return {
    addresses: {
      identityRegistry: ADDRESS,
      agentIndex: ADDRESS,
      providerRegistry: ADDRESS,
      serviceRegistry: ADDRESS,
      validationRegistry: ADDRESS,
      reputationStorage: ADDRESS,
    },
    resolveWallet: vi.fn(async () => ({ agentId: "7", found: true })),
    listProviders: vi.fn(async () => ({ total: "0", providers: [] })),
    getProvider: vi.fn(async (agentId: bigint) => ({ agentId: agentId.toString() })),
    getService: vi.fn(async () => { throw new Error("not exercised"); }),
    ...overrides,
  };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

function marketplaceTools(reader: MarketplaceChainReader): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  registerMarketplaceTools(server, reader, async () => []);
  return tools;
}

function errorPayload(result: McpToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const [block] = result.content;
  if (!block || block.type !== "text") throw new Error("expected a text content block");
  const payload = JSON.parse(block.text) as Record<string, unknown>;
  expect(result.structuredContent).toEqual(payload);
  return payload;
}

describe("MCP marketplace tools", () => {
  it("answers an unknown provider id with a non-retryable MARKETPLACE_NOT_FOUND", async () => {
    const tools = marketplaceTools(stubReader({
      getProvider: vi.fn(async () => { throw new MarketplaceNotFoundError("provider", "42"); }),
    }));

    const result = await tools.get("daski_get_provider")!({ agentId: "42" });

    expect(errorPayload(result)).toEqual({
      code: "MARKETPLACE_NOT_FOUND",
      message: "No provider is registered under id 42",
      retryable: false,
      next_action:
        "Check the id with daski_list_providers or daski_list_outcomes; unknown ids are not retried.",
    });
  });

  it("answers an unknown service id with a non-retryable MARKETPLACE_NOT_FOUND", async () => {
    const tools = marketplaceTools(stubReader({
      getService: vi.fn(async () => { throw new MarketplaceNotFoundError("service", SERVICE_ID); }),
    }));

    const result = await tools.get("daski_get_service")!({ serviceId: SERVICE_ID });

    expect(errorPayload(result)).toMatchObject({
      code: "MARKETPLACE_NOT_FOUND",
      message: `No service is registered under id ${SERVICE_ID}`,
      retryable: false,
    });
  });

  it("keeps every other failure as a retryable chain-read failure", async () => {
    const tools = marketplaceTools(stubReader({
      getProvider: vi.fn(async () => { throw new Error("socket hang up"); }),
    }));

    const result = await tools.get("daski_get_provider")!({ agentId: "42" });

    expect(errorPayload(result)).toEqual({
      code: "MARKETPLACE_CHAIN_READ_FAILED",
      message: "Marketplace chain state is unavailable",
      retryable: true,
    });
  });
});

let server: Server | undefined;

async function start(reader: MarketplaceChainReader): Promise<string> {
  const app = express();
  app.use(createMarketplaceRouter(reader));
  const listener = await new Promise<Server>((resolve, reject) => {
    const created: Server = app.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) reject(error);
      else resolve(created);
    });
  });
  server = listener;
  const details = listener.address();
  if (!details || typeof details === "string") throw new Error("test listener unavailable");
  return `http://127.0.0.1:${details.port}`;
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe("HTTP marketplace registry", () => {
  it("answers unknown provider and service ids with 404 MARKETPLACE_NOT_FOUND", async () => {
    const baseUrl = await start(stubReader({
      getProvider: vi.fn(async () => { throw new MarketplaceNotFoundError("provider", "42"); }),
      getService: vi.fn(async () => { throw new MarketplaceNotFoundError("service", SERVICE_ID); }),
    }));

    const [provider, service] = await Promise.all([
      fetch(`${baseUrl}/public/v2/registry/providers/42`),
      fetch(`${baseUrl}/public/v2/registry/services/${SERVICE_ID}`),
    ]);

    expect(provider.status).toBe(404);
    expect(await provider.json()).toEqual({
      error: { code: "MARKETPLACE_NOT_FOUND", message: "No provider is registered under id 42" },
    });
    expect(service.status).toBe(404);
    expect(await service.json()).toEqual({
      error: { code: "MARKETPLACE_NOT_FOUND", message: `No service is registered under id ${SERVICE_ID}` },
    });
  });

  it("keeps every other failure as a 502 chain-read failure", async () => {
    const baseUrl = await start(stubReader({
      getProvider: vi.fn(async () => { throw new Error("socket hang up"); }),
    }));

    const response = await fetch(`${baseUrl}/public/v2/registry/providers/42`);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "MARKETPLACE_CHAIN_READ_FAILED", message: "Marketplace chain state is unavailable." },
    });
  });
});
