import { createCipheriv } from "node:crypto";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { expect, it, vi } from "vitest";
import { StandardReputationWorker } from "../src/standardRail/reputationWorker.js";
import { logger } from "../src/util/logger.js";

it("logs the reserve of the persisted signed transaction on balance_fee, even after a ceiling change", async () => {
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const raw = await account.signTransaction({ chainId: 8453, type: "eip1559", nonce: 1,
    to: account.address, gas: 1_500_000n, maxFeePerGas: 100_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n, value: 0n });
  const key = Buffer.alloc(32, 1); const iv = Buffer.alloc(12, 2);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("standard-reputation:operation-1"));
  const ciphertext = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
  const worker = new StandardReputationWorker({ query } as never, {
    reputationRelayerPrivateKey: `0x${"11".repeat(32)}`,
    evidenceRpcUrls: ["https://rpc.example.test"], encryptionKey: key,
    reputationMaxFeePerGasWei: 3_000_000_000n,
    reputationRetryDelaysSeconds: [10,20,40,60],
  } as never, base);
  const internal = worker as unknown as {
    broadcastClient: { sendRawTransaction(args: unknown): Promise<Hex> };
    sendPersisted(operation: unknown, transaction: unknown): Promise<void>;
  };
  const send = vi.spyOn(internal.broadcastClient, "sendRawTransaction").mockRejectedValue(new Error("insufficient funds"));
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    await internal.sendPersisted({ operation_id: "operation-1", attempts: 0 }, {
      transaction_id: "transaction-1", state: "prepared", transaction_hash: keccak256(raw),
      encrypted_raw_transaction: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
    });
    expect(warn).toHaveBeenCalledWith("standard reputation fee reserve required", expect.objectContaining({
      reason: "balance_fee", gasLimit: "1500000", maxFeePerGasWei: "100000000000",
      requiredReserveWei: "150000000000000000",
    }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE standard_reputation_operations"),
      ["operation-1", 1, "balance_fee", "pending", 10]);
  } finally { send.mockRestore(); warn.mockRestore(); }
});
