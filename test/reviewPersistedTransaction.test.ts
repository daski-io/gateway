import { createCipheriv } from "node:crypto";
import { keccak256, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { expect, it, vi } from "vitest";
import { StandardReputationWorker } from "../src/standardRail/reputationWorker.js";
import { encodeReputationOperation, type RevokeConfirmationIntent } from "../src/standardRail/reputationOperation.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";

for (const chain of [base, baseSepolia]) {
  for (const change of ["none", "value", "chain", "destination", "calldata", "hash"] as const) {
    it(`${chain.id}: persisted review ${change === "none" ? "broadcasts canonical zero value" : `rejects changed ${change}`}`, async () => {
      const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
      const key = Buffer.alloc(32, 1);
      const config = { reputationRelayerPrivateKey: `0x${"11".repeat(32)}`,
        evidenceRpcUrls: ["https://rpc.example.test"], encryptionKey: key,
        easAddress: "0x4200000000000000000000000000000000000021",
        reputationConfirmationGasLimit: 500000n } as unknown as StandardRailConfig;
      const intent: RevokeConfirmationIntent = {
        operation: "revoke-confirmation", profileId: chain.id === 8453 ? "eas-native-1.0.1" : "eas-native-1.2.0",
        orderKey: `0x${"22".repeat(32)}`, orderId: "order-1", outcomeId: "mailbox", submissionsUsed: 1,
        request: { schema: `0x${"33".repeat(32)}`, data: { uid: `0x${"44".repeat(32)}`, value: "0" },
          signature: { v: 27, r: `0x${"55".repeat(32)}`, s: `0x${"66".repeat(32)}` },
          revoker: account.address, deadline: chain.id === 8453 ? null : "1791000000" },
      };
      const encoded = encodeReputationOperation(intent, config);
      const raw = await account.signTransaction({ chainId: change === "chain" ? 1 : chain.id,
        type: "eip1559", nonce: 1, to: change === "destination" ? account.address : encoded.destination,
        gas: encoded.gas, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000n,
        value: change === "value" ? 1n : 0n, data: change === "calldata" ? "0x12" : encoded.data });
      if (change === "none") expect(parseTransaction(raw).value).toBeUndefined();
      const iv = Buffer.alloc(12, 2);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from("standard-reputation:operation-1"));
      const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
      const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
      const worker = new StandardReputationWorker({ query } as never, config, chain);
      const internal = worker as unknown as {
        broadcastClient: { sendRawTransaction(args: unknown): Promise<Hex> };
        sendPersisted(operation: unknown, transaction: unknown): Promise<void>;
      };
      const send = vi.spyOn(internal.broadcastClient, "sendRawTransaction").mockResolvedValue(keccak256(raw));
      await internal.sendPersisted({ operation_id: "operation-1", kind: "confirmation-v2", canonical_intent: intent }, {
        transaction_id: "transaction-1", state: "prepared",
        transaction_hash: change === "hash" ? `0x${"77".repeat(32)}` : keccak256(raw),
        encrypted_raw_transaction: Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
      });
      if (change === "none") {
        expect(send).toHaveBeenCalledExactlyOnceWith({ serializedTransaction: raw });
        expect(query).toHaveBeenCalledWith(expect.stringContaining("WITH marked"), ["operation-1", "transaction-1"]);
      } else {
        expect(send).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE standard_reputation_operations"),
          ["operation-1", "operator_attention", "transaction_intent_mismatch"]);
      }
    });
  }
}
