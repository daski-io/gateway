import { describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import { baseSepolia } from "viem/chains";
import { reputationRegistryAbi } from "../src/chain/abis.js";
import { encodeFeedbackCalldata } from "../src/chain/feedbackCalldata.js";
import { createFeedbackMethods } from "../src/chain/viemFeedback.js";
import type {
  FeedbackInput,
  PreparedFeedbackTransaction,
} from "../src/chain/reader.js";
import type { Hex } from "../src/types.js";

const REGISTRY =
  "0x8004b663056a597dffe9eccc1965a193b7388713" as Hex;
const CLIENT = "0x08004fddb4e7b64977d341ad9d6b98b4d10d6ed2" as Hex;
const UID =
  "0xcafe000000000000000000000000000000000000000000000000000000000001" as Hex;
const TRANSACTION_HASH =
  "0x3e43514fa66dd99cc55cebe95d687f81c9a3275e2223252223c52b05d37510fa" as Hex;
const SERIALIZED_TRANSACTION = "0x02" as Hex;
const INPUT: FeedbackInput = {
  agentId: 8327n,
  value: 100n,
  valueDecimals: 0,
  tag1: "daski",
  tag2: "domain-management",
  endpoint: "",
  feedbackURI:
    "https://base-sepolia.easscan.org/attestation/view/" + UID,
  feedbackHash: UID,
};

// Copied from the verified Base Sepolia implementation at
// 0x16e0fa7f7c56b9a767e34b192b51f921be31da34.
const DEPLOYED_GIVE_FEEDBACK_ABI = {
  type: "function",
  name: "giveFeedback",
  inputs: [
    { name: "agentId", type: "uint256" },
    { name: "value", type: "int128" },
    { name: "valueDecimals", type: "uint8" },
    { name: "tag1", type: "string" },
    { name: "tag2", type: "string" },
    { name: "endpoint", type: "string" },
    { name: "feedbackURI", type: "string" },
    { name: "feedbackHash", type: "bytes32" },
  ],
  outputs: [],
  stateMutability: "nonpayable",
} as const;

const EXPECTED_CALLDATA =
  "0x3c036a7e00000000000000000000000000000000000000000000000000000000000020870000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001a0cafe00000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000056461736b690000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000011646f6d61696e2d6d616e6167656d656e740000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007468747470733a2f2f626173652d7365706f6c69612e6561737363616e2e6f72672f6174746573746174696f6e2f766965772f307863616665303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303031000000000000000000000000" as Hex;

function feedbackMethods(input: {
  receipt?: { status: "success" | "reverted"; logs: [] };
  receiptError?: Error;
}) {
  const publicClient = {
    waitForTransactionReceipt: vi.fn(async () => {
      if (input.receiptError) throw input.receiptError;
      return input.receipt;
    }),
  };
  const walletClient = {
    sendRawTransaction: vi.fn().mockResolvedValue(TRANSACTION_HASH),
  };
  const account = { address: CLIENT };
  return createFeedbackMethods({
    publicClient: publicClient as any,
    walletClient: walletClient as any,
    account: account as any,
    chain: baseSepolia,
    reputationRegistryAddress: REGISTRY,
  });
}

describe("canonical ReputationRegistry calldata", () => {
  it("pins giveFeedback to the deployed Base Sepolia ABI", () => {
    const fragment = reputationRegistryAbi.find(
      (item) => item.type === "function" && item.name === "giveFeedback",
    );
    expect(fragment).toEqual(DEPLOYED_GIVE_FEEDBACK_ABI);
  });

  it("encodes a known input byte-for-byte", () => {
    expect(encodeFeedbackCalldata(INPUT)).toBe(EXPECTED_CALLDATA);
  });

  it("prepares an actual call to the registry", async () => {
    const prepareTransactionRequest = vi.fn(async (request) => ({
      ...request,
      nonce: 7,
    }));
    const account = {
      address: CLIENT,
      signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TRANSACTION),
    };
    const methods = createFeedbackMethods({
      publicClient: {
        simulateContract: vi.fn().mockResolvedValue({
          request: { gas: 300_000n },
        }),
      } as any,
      walletClient: { prepareTransactionRequest } as any,
      account: account as any,
      chain: baseSepolia,
      reputationRegistryAddress: REGISTRY,
    });

    const prepared = await methods.prepareFeedback(INPUT, 7n);

    expect(prepareTransactionRequest).toHaveBeenCalledWith({
      account,
      chain: baseSepolia,
      to: REGISTRY,
      data: EXPECTED_CALLDATA,
      gas: 300_000n,
      nonce: 7n,
    });
    expect(prepared).toEqual({
      transactionHash: keccak256(SERIALIZED_TRANSACTION),
      serializedTransaction: SERIALIZED_TRANSACTION,
      facilitatorNonce: 7n,
    });
  });
});

describe("canonical ReputationRegistry receipt outcomes", () => {
  const prepared: PreparedFeedbackTransaction = {
    transactionHash: TRANSACTION_HASH,
    serializedTransaction: SERIALIZED_TRANSACTION,
    facilitatorNonce: 0n,
  };

  it("classifies a reverted receipt as permanent", async () => {
    const methods = feedbackMethods({
      receipt: { status: "reverted", logs: [] },
    });

    await expect(
      methods.submitPreparedFeedback(prepared, INPUT),
    ).rejects.toMatchObject({
      failure: "reverted",
    });
  });

  it("classifies success without NewFeedback as permanent", async () => {
    const methods = feedbackMethods({
      receipt: { status: "success", logs: [] },
    });

    await expect(
      methods.submitPreparedFeedback(prepared, INPUT),
    ).rejects.toMatchObject({
      failure: "succeeded_without_event",
    });
  });

  it("leaves transient RPC failures retryable", async () => {
    const rpcError = new Error("RPC request timed out");
    const methods = feedbackMethods({ receiptError: rpcError });

    await expect(
      methods.submitPreparedFeedback(prepared, INPUT),
    ).rejects.toBe(rpcError);
  });

  it("treats an already-known raw transaction as broadcast", async () => {
    const onBroadcast = vi.fn();
    const methods = createFeedbackMethods({
      publicClient: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          status: "success",
          logs: [],
        }),
      } as any,
      walletClient: {
        sendRawTransaction: vi
          .fn()
          .mockRejectedValue(new Error("already known")),
      } as any,
      account: { address: CLIENT } as any,
      chain: baseSepolia,
      reputationRegistryAddress: REGISTRY,
    });

    await expect(
      methods.submitPreparedFeedback(prepared, INPUT, onBroadcast),
    ).rejects.toMatchObject({ failure: "succeeded_without_event" });
    expect(onBroadcast).toHaveBeenCalledWith(TRANSACTION_HASH);
  });
});
