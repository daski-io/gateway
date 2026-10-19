import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  numberToHex,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Config } from "../src/config.js";
import { reputationStorageAbi, serviceRegistryAbi } from "../src/marketplace/abis.js";
import { ViemMarketplaceChainReader } from "../src/marketplace/reader.js";
import { resetRpcEndpointHealth, rpcEndpointHealthSnapshot } from "../src/rpc/endpointHealth.js";
import { resetRpcFailoverLogThrottle } from "../src/rpc/failover.js";
import { logger } from "../src/util/logger.js";
import { stubRpcFetch, type StubbedRpcRequest } from "./helpers/rpcStub.js";

const PRIMARY = "https://primary.example.test/v3/test-key-0123";
const FALLBACK = "https://fallback.example.test/";
const ADDRESS = getAddress("0x1111111111111111111111111111111111111111");
const SERVICE_ID = `0x${"22".repeat(32)}` as Hex;
const abi = [...serviceRegistryAbi, ...reputationStorageAbi];

function block(number: bigint) {
  return {
    number: numberToHex(number), hash: `0x${number.toString(16).padStart(64, "0")}`,
    parentHash: `0x${"00".repeat(32)}`, timestamp: "0x1", transactions: [],
  };
}

function answer({ method, params }: StubbedRpcRequest) {
  if (method === "eth_getBlockByNumber") return { result: block(params[0] === "safe" ? 110n : 100n) };
  const [{ data }] = params as [{ data: Hex }];
  const { functionName } = decodeFunctionData({ abi, data });
  if (functionName === "getService") {
    return { result: encodeFunctionResult({ abi: serviceRegistryAbi, functionName: "getService", result: {
      providerAgentId: 7n, serviceId: SERVICE_ID, serviceSlug: "service", version: "1.0.0",
      serviceURI: "https://example.com", serviceWallet: ADDRESS, serviceWalletOwner: ADDRESS,
      serviceWalletAgentWallet: ADDRESS, createdAt: 1n, active: true,
    } }) };
  }
  return { result: encodeFunctionResult({
    abi: reputationStorageAbi, functionName: "getServiceStats", result: [1n, 2n, 3n, 4n, 5n, 6n, 7n],
  }) };
}

const reader = () => new ViemMarketplaceChainReader({
  finalityTag: "finalized",
  marketplaceContracts: {
    identityRegistry: ADDRESS, agentIndex: ADDRESS, providerRegistry: ADDRESS,
    serviceRegistry: ADDRESS, validationRegistry: ADDRESS, reputationStorage: ADDRESS,
  },
} as Config, [PRIMARY, FALLBACK], baseSepolia);

let warn: MockInstance<(message: string, details?: unknown) => void>;

beforeEach(() => {
  resetRpcEndpointHealth();
  resetRpcFailoverLogThrottle();
  warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  warn.mockRestore();
});

describe("a reader observation through the real transports", () => {
  it("moves a whole observation to the fallback at once when the primary answers -32603", async () => {
    vi.useFakeTimers();
    const fetchFn = stubRpcFetch((request) => request.url === PRIMARY && request.method === "eth_call"
      ? { error: { code: -32603, message: "Internal error" } }
      : answer(request));
    vi.stubGlobal("fetch", fetchFn);

    const service = await reader().getService(SERVICE_ID);

    expect(service).toMatchObject({ serviceId: SERVICE_ID, standardReputation: { transactions: "7", safeBlock: "110" } });
    // No backoff ran: the observation did not wait for a timer.
    expect(vi.getTimerCount()).toBe(0);
    // The fallback re-read both blocks it pinned the calls to.
    const fallback = fetchFn.calls.filter((call) => call.url === FALLBACK).map((call) => call.method);
    expect(fallback.filter((method) => method === "eth_getBlockByNumber")).toHaveLength(2);
    expect(fallback.filter((method) => method === "eth_call")).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith("marketplace RPC fallback selected", expect.objectContaining({
      primaryHost: "primary.example.test", selectedHost: "fallback.example.test",
      operation: "marketplace.getService", reason: "internal_error",
    }));
    expect(warn).toHaveBeenCalledWith("RPC endpoint attempt failed", expect.objectContaining({
      host: "primary.example.test", operation: "marketplace.getService", method: "eth_call", code: -32603,
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("test-key-0123");
  });

  it("stops sending reads to a primary whose circuit opened", async () => {
    const fetchFn = stubRpcFetch((request) => request.url === PRIMARY
      ? { error: { code: -32603, message: "Internal error" } }
      : answer(request));
    vi.stubGlobal("fetch", fetchFn);
    const subject = reader();
    for (let index = 0; index < 3; index += 1) await subject.getService(SERVICE_ID);
    expect(rpcEndpointHealthSnapshot().find((entry) => entry.host === "primary.example.test")?.state).toBe("open");
    const before = fetchFn.calls.filter((call) => call.url === PRIMARY).length;
    await subject.getService(SERVICE_ID);
    expect(fetchFn.calls.filter((call) => call.url === PRIMARY)).toHaveLength(before);
  });
});
