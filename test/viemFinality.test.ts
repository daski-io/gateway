import { describe, expect, it, vi } from "vitest";
import { baseSepolia } from "viem/chains";
import { createConfirmationMethods } from "../src/chain/viemConfirmation.js";
import { createFeedbackMethods } from "../src/chain/viemFeedback.js";
import type {
  ConfirmationDelegationInput,
  FeedbackInput,
  FeedbackRevocationInput,
  PreparedConfirmationTransaction,
  PreparedFeedbackTransaction,
} from "../src/chain/reader.js";
import type { Hex } from "../src/types.js";

const ADDRESS = "0x0000000000000000000000000000000000000011" as Hex;
const TRANSACTION_HASH = `0x${"22".repeat(32)}` as Hex;
const SERIALIZED_TRANSACTION = "0x02" as Hex;
const BYTES32 = `0x${"33".repeat(32)}` as Hex;

const CONFIRMATION_INPUT: ConfirmationDelegationInput = {
  attester: ADDRESS,
  schema: BYTES32,
  recipient: ADDRESS,
  expirationTime: 0n,
  revocable: true,
  refUID: `0x${"00".repeat(32)}` as Hex,
  data: "0x",
  value: 0n,
  deadline: 4_000_000_000n,
  signature: {
    v: 27,
    r: BYTES32,
    s: BYTES32,
  },
};

const FEEDBACK_INPUT: FeedbackInput = {
  agentId: 2n,
  value: 100n,
  valueDecimals: 0,
  tag1: "daski",
  tag2: "domain-management",
  endpoint: "",
  feedbackURI: `https://base.easscan.org/attestation/view/${BYTES32}`,
  feedbackHash: BYTES32,
};

const REVOCATION_INPUT: FeedbackRevocationInput = {
  agentId: 2n,
  feedbackIndex: 1n,
};

const PREPARED_CONFIRMATION: PreparedConfirmationTransaction = {
  transactionHash: TRANSACTION_HASH,
  serializedTransaction: SERIALIZED_TRANSACTION,
  facilitatorNonce: 1n,
};

const PREPARED_FEEDBACK: PreparedFeedbackTransaction = {
  transactionHash: TRANSACTION_HASH,
  serializedTransaction: SERIALIZED_TRANSACTION,
  facilitatorNonce: 1n,
};

function confirmationMethods(
  publicClient: Record<string, unknown>,
  walletClient: Record<string, unknown> = {},
) {
  return createConfirmationMethods({
    publicClient: publicClient as any,
    walletClient: {
      sendRawTransaction: vi.fn().mockResolvedValue(TRANSACTION_HASH),
      ...walletClient,
    } as any,
    account: { address: ADDRESS } as any,
    chain: baseSepolia,
    easAddress: ADDRESS,
    maxTransactionFeeWei: 10n ** 18n,
  });
}

function feedbackMethods(
  publicClient: Record<string, unknown>,
  walletClient: Record<string, unknown> = {},
) {
  return createFeedbackMethods({
    publicClient: publicClient as any,
    walletClient: {
      sendRawTransaction: vi.fn().mockResolvedValue(TRANSACTION_HASH),
      ...walletClient,
    } as any,
    account: { address: ADDRESS } as any,
    chain: baseSepolia,
    reputationRegistryAddress: ADDRESS,
    maxTransactionFeeWei: 10n ** 18n,
  });
}

describe("facilitator write finality", () => {
  it("waits for 12 confirmations before finalizing non-settlement writes", async () => {
    const confirmationWaitError = new Error("confirmation still shallow");
    const confirmationWait = vi
      .fn()
      .mockRejectedValue(confirmationWaitError);
    const confirmations = confirmationMethods({
      waitForTransactionReceipt: confirmationWait,
    });

    await expect(
      confirmations.submitPreparedBuyerConfirmation(
        PREPARED_CONFIRMATION,
        CONFIRMATION_INPUT,
      ),
    ).rejects.toMatchObject({ stage: "unknown" });
    expect(confirmationWait).toHaveBeenCalledWith({
      hash: TRANSACTION_HASH,
      confirmations: 12,
    });

    const feedbackWaitError = new Error("feedback still shallow");
    const feedbackWait = vi.fn().mockRejectedValue(feedbackWaitError);
    const feedback = feedbackMethods({
      waitForTransactionReceipt: feedbackWait,
    });

    await expect(
      feedback.submitPreparedFeedback(PREPARED_FEEDBACK, FEEDBACK_INPUT),
    ).rejects.toBe(feedbackWaitError);
    await expect(
      feedback.submitPreparedFeedbackRevocation(
        PREPARED_FEEDBACK,
        REVOCATION_INPUT,
      ),
    ).rejects.toBe(feedbackWaitError);
    expect(feedbackWait).toHaveBeenNthCalledWith(1, {
      hash: TRANSACTION_HASH,
      confirmations: 12,
    });
    expect(feedbackWait).toHaveBeenNthCalledWith(2, {
      hash: TRANSACTION_HASH,
      confirmations: 12,
    });
  });

  it("keeps shallow confirmation and feedback receipts pending during recovery", async () => {
    const receipt = {
      status: "success",
      blockNumber: 100n,
      logs: [],
    };
    const getTransactionReceipt = vi.fn().mockResolvedValue(receipt);
    const getTransactionConfirmations = vi.fn().mockResolvedValue(11n);
    const publicClient = {
      getTransactionReceipt,
      getTransactionConfirmations,
    };

    await expect(
      confirmationMethods(publicClient).getBuyerConfirmationByTransaction(
        TRANSACTION_HASH,
        CONFIRMATION_INPUT,
      ),
    ).resolves.toBeNull();

    const feedback = feedbackMethods(publicClient);
    await expect(
      feedback.getFeedbackByTransaction(TRANSACTION_HASH, FEEDBACK_INPUT),
    ).resolves.toBeNull();
    await expect(
      feedback.getFeedbackRevocationByTransaction(
        TRANSACTION_HASH,
        REVOCATION_INPUT,
      ),
    ).resolves.toBeNull();

    expect(getTransactionConfirmations).toHaveBeenCalledTimes(3);
    expect(getTransactionConfirmations).toHaveBeenCalledWith({
      transactionReceipt: receipt,
    });
  });

  it("accepts a feedback revocation once the 12-block policy is met", async () => {
    const receipt = {
      status: "success",
      blockNumber: 100n,
      logs: [],
    };
    const methods = feedbackMethods({
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      getTransactionConfirmations: vi.fn().mockResolvedValue(12n),
    });

    await expect(
      methods.getFeedbackRevocationByTransaction(
        TRANSACTION_HASH,
        REVOCATION_INPUT,
      ),
    ).resolves.toEqual({ transactionHash: TRANSACTION_HASH });
  });
});
