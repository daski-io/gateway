import { http, type HttpTransportConfig, type Transport } from "viem";
import { annotateRpcError } from "./classification.js";

/** Head, nonce, balance, code and small `eth_call` reads at a block tag. */
export const RPC_SHORT_READ_TIMEOUT_MS = 5_000;
/** `eth_getLogs`, multicalls and state reads pinned to a block (archive reads). */
export const RPC_LONG_READ_TIMEOUT_MS = 15_000;

const SHORT_METHODS: ReadonlySet<string> = new Set([
  "eth_blockNumber",
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_estimateGas",
]);
/** Position of the block parameter of each state read. */
const STATE_READ_BLOCK_PARAMETER: Readonly<Record<string, number>> = {
  eth_call: 1,
  eth_getCode: 1,
  eth_getBalance: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
};
const BLOCK_TAGS: ReadonlySet<string> = new Set(["latest", "pending", "safe", "finalized", "earliest"]);
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const AGGREGATE3_SELECTOR = "0x82ad56cb";

function isMulticall(call: unknown): boolean {
  if (!call || typeof call !== "object") return false;
  const { to, data, input } = call as { to?: unknown; data?: unknown; input?: unknown };
  const calldata = typeof data === "string" ? data : typeof input === "string" ? input : "";
  return (typeof to === "string" && to.toLowerCase() === MULTICALL3) ||
    calldata.toLowerCase().startsWith(AGGREGATE3_SELECTOR);
}

/** The timeout of one JSON-RPC read, from its method and block parameter. */
export function rpcReadTimeoutMs(method: string, params: unknown): number {
  if (SHORT_METHODS.has(method)) return RPC_SHORT_READ_TIMEOUT_MS;
  const index = STATE_READ_BLOCK_PARAMETER[method];
  if (index === undefined) return RPC_LONG_READ_TIMEOUT_MS;
  const list = Array.isArray(params) ? params : [];
  if (method === "eth_call" && isMulticall(list[0])) return RPC_LONG_READ_TIMEOUT_MS;
  const block = list[index];
  // A missing parameter means `latest`; a number, hash or EIP-1898 selector pins history.
  if (block === undefined || block === null || (typeof block === "string" && BLOCK_TAGS.has(block))) {
    return RPC_SHORT_READ_TIMEOUT_MS;
  }
  return RPC_LONG_READ_TIMEOUT_MS;
}

/**
 * An HTTP JSON-RPC transport for reads with a timeout per method (see
 * rpcReadTimeoutMs) and viem's own retries off: the failover owns retries.
 * A failed request's error carries its method and latency for the failover's
 * log, invisibly to error serialization.
 */
export function rpcReadTransport(
  url: string,
  options: { fetchFn?: HttpTransportConfig["fetchFn"] } = {},
): Transport {
  const short = http(url, { retryCount: 0, timeout: RPC_SHORT_READ_TIMEOUT_MS, fetchFn: options.fetchFn });
  const long = http(url, { retryCount: 0, timeout: RPC_LONG_READ_TIMEOUT_MS, fetchFn: options.fetchFn });
  return (parameters) => {
    const fast = short(parameters);
    const slow = long(parameters);
    const request = (async (args: { method: string; params?: unknown }, requestOptions?: unknown) => {
      const target = rpcReadTimeoutMs(args.method, args.params) > RPC_SHORT_READ_TIMEOUT_MS ? slow : fast;
      const started = Date.now();
      try {
        return await target.request(args as never, requestOptions as never);
      } catch (error) {
        annotateRpcError(error, { method: args.method, latencyMs: Date.now() - started });
        throw error;
      }
    }) as typeof fast.request;
    return { ...fast, request };
  };
}
