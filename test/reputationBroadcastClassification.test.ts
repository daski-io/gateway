import { createCipheriv } from "node:crypto";
import { createPublicClient, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyBroadcastFailure } from "../src/rpc/classification.js";
import { StandardReputationWorker } from "../src/standardRail/reputationWorker.js";
import { logger } from "../src/util/logger.js";
import { jsonRpcErrorResponse, stubRpcFetch, type StubbedRpcReply } from "./helpers/rpcStub.js";

const RPC_URL = "https://rpc.example.test/v3/test-key-0123";
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

/** A signed transaction whose raw hex happens to contain "fee", as real ones often do. */
async function rawContainingFee(): Promise<Hex> {
  for (let nonce = 0; nonce < 10_000; nonce += 1) {
    const raw = await account.signTransaction({
      chainId: 8453, type: "eip1559", nonce, to: account.address, gas: 1_500_000n,
      maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000n, value: 0n,
    });
    if (raw.slice(2).includes("fee")) return raw;
  }
  throw new Error("no fixture transaction contains fee");
}

async function broadcastError(reply: StubbedRpcReply, raw: Hex): Promise<unknown> {
  const fetchFn = stubRpcFetch(() => reply);
  const client = createPublicClient({ chain: base, transport: http(RPC_URL, { retryCount: 0, fetchFn }) });
  return client.sendRawTransaction({ serializedTransaction: raw }).then(
    () => { throw new Error("expected a rejection"); },
    (error: unknown) => error,
  );
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("raw-transaction broadcast classification", () => {
  it("classifies real viem broadcast errors from the node's answer only", async () => {
    const raw = await rawContainingFee();
    const cases: Array<[StubbedRpcReply, ReturnType<typeof classifyBroadcastFailure>]> = [
      [{ error: { code: -32603, message: "Internal error" } }, "unavailable"],
      [{ error: { code: -32000, message: "already known" } }, "already_known"],
      [{ error: { code: -32000, message: "nonce too low: next nonce 5, tx nonce 4" } }, "nonce_conflict"],
      [{ error: { code: -32000, message: "replacement transaction underpriced" } }, "nonce_conflict"],
      [{ error: { code: -32000, message: "insufficient funds for gas * price + value" } }, "balance_fee"],
      [{ error: { code: -32000, message: "max fee per gas less than block base fee" } }, "balance_fee"],
      [jsonRpcErrorResponse(429, { code: -32005, message: "Too Many Requests" }), "unavailable"],
      [new Response("Bad Gateway", { status: 502 }), "unavailable"],
      [new TypeError("fetch failed"), "unavailable"],
    ];
    for (const [reply, expected] of cases) {
      const error = await broadcastError(reply, raw);
      // viem's composed message carries the URL and the raw transaction.
      expect((error as Error).message).toContain(raw);
      expect(classifyBroadcastFailure(error)).toBe(expected);
    }
  });

  it("keeps the existing rules for an error that is not viem's", () => {
    expect(classifyBroadcastFailure(new Error("insufficient funds"))).toBe("balance_fee");
    expect(classifyBroadcastFailure(new Error("nonce too low"))).toBe("nonce_conflict");
    expect(classifyBroadcastFailure(new Error("already known"))).toBe("already_known");
    expect(classifyBroadcastFailure(new Error("socket hang up"))).toBe("unavailable");
  });

  it("treats a -32603 broadcast whose raw hex spells fee as an RPC failure, not a fee reserve", async () => {
    const raw = await rawContainingFee();
    const key = Buffer.alloc(32, 1); const iv = Buffer.alloc(12, 2);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("standard-reputation:operation-1"));
    const ciphertext = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
    const fetchFn = stubRpcFetch(() => ({ error: { code: -32603, message: "Internal error" } }));
    vi.stubGlobal("fetch", fetchFn);
    const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const worker = new StandardReputationWorker({ query } as never, {
      reputationRelayerPrivateKey: `0x${"11".repeat(32)}`,
      evidenceRpcUrls: [RPC_URL], encryptionKey: key,
      reputationMaxFeePerGasWei: 3_000_000_000n,
      reputationRetryDelaysSeconds: [10, 20, 40, 60],
    } as never, base);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await (worker as unknown as { sendPersisted(operation: unknown, transaction: unknown): Promise<void> }).sendPersisted(
      { operation_id: "operation-1", attempts: 0, kind: "register" },
      { transaction_id: "transaction-1", state: "prepared", transaction_hash: keccak256(raw),
        encrypted_raw_transaction: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]) },
    );
    expect(fetchFn.calls.map((call) => call.method)).toEqual(["eth_sendRawTransaction"]);
    expect(warn).not.toHaveBeenCalledWith("standard reputation fee reserve required", expect.anything());
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE standard_reputation_operations"),
      ["operation-1", 1, "rpc_finality", "pending", 10]);
  });
});
