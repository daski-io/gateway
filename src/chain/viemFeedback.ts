import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  keccak256,
  parseEventLogs,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import type { base, baseSepolia } from "viem/chains";
import type { Hex } from "../types.js";
import { knownErrorAbis, reputationRegistryAbi } from "./abis.js";
import {
  encodeFeedbackCalldata,
  feedbackArgs,
} from "./feedbackCalldata.js";
import { FeedbackSubmissionError } from "./feedbackErrors.js";
import { isAlreadyKnownTransaction } from "./transactionErrors.js";
import type {
  ChainReader,
  FeedbackInput,
  FeedbackResult,
  PreparedFeedbackTransaction,
} from "./reader.js";
import { decodeRevertReason } from "./viemErrors.js";

type SupportedChain = typeof base | typeof baseSepolia;
type FeedbackMethods = Pick<
  ChainReader,
  | "prepareFeedback"
  | "submitPreparedFeedback"
  | "getFeedbackByTransaction"
  | "getFacilitatorTransactionCount"
  | "revokeFeedback"
>;

export interface FeedbackDeps {
  publicClient: PublicClient<Transport, SupportedChain>;
  walletClient: WalletClient<Transport, SupportedChain, PrivateKeyAccount>;
  account: PrivateKeyAccount;
  chain: SupportedChain;
  reputationRegistryAddress?: Hex;
}

function isContractRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return Boolean(
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError,
    ),
  );
}

export function createFeedbackMethods(deps: FeedbackDeps): FeedbackMethods {
  const registry = (): Hex => {
    if (!deps.reputationRegistryAddress) {
      throw new Error(
        "REPUTATION_REGISTRY_ADDRESS is not configured — feedback unavailable",
      );
    }
    return deps.reputationRegistryAddress;
  };

  const resultFromReceipt = async (
    transactionHash: Hex,
    input: FeedbackInput,
    receipt: TransactionReceipt,
  ): Promise<FeedbackResult> => {
    if (receipt.status !== "success") {
      throw new FeedbackSubmissionError(
        "reverted",
        `giveFeedback transaction reverted (${transactionHash})`,
      );
    }
    const logs = receipt.logs.filter(
      (log) => log.address.toLowerCase() === registry().toLowerCase(),
    );
    const parsed = parseEventLogs({
      abi: reputationRegistryAbi,
      eventName: "NewFeedback",
      logs: logs as any,
    });
    const match = parsed.find((event: any) => {
      const args = event.args as {
        agentId: bigint;
        clientAddress: Hex;
        feedbackHash: Hex;
      };
      return (
        args.agentId === input.agentId &&
        args.clientAddress.toLowerCase() === deps.account.address.toLowerCase() &&
        args.feedbackHash.toLowerCase() === input.feedbackHash.toLowerCase()
      );
    });
    if (!match) {
      throw new FeedbackSubmissionError(
        "succeeded_without_event",
        `giveFeedback transaction succeeded without NewFeedback event (${transactionHash})`,
      );
    }
    const feedbackIndex = (match as any).args.feedbackIndex as
      | bigint
      | undefined;
    if (feedbackIndex == null) {
      throw new FeedbackSubmissionError(
        "malformed_event",
        `NewFeedback event omitted feedbackIndex (${transactionHash})`,
      );
    }
    return {
      transactionHash,
      feedbackIndex,
    };
  };

  const simulate = async (input: FeedbackInput) => {
    try {
      return await deps.publicClient.simulateContract({
        address: registry(),
        abi: [...reputationRegistryAbi, ...knownErrorAbis],
        functionName: "giveFeedback",
        args: feedbackArgs(input),
        account: deps.account,
        chain: deps.chain,
        gas: 300_000n,
      });
    } catch (error) {
      if (isContractRevert(error)) {
        throw new FeedbackSubmissionError(
          "reverted",
          `giveFeedback reverted: ${decodeRevertReason(error)}`,
        );
      }
      throw error;
    }
  };

  return {
    async prepareFeedback(
      input: FeedbackInput,
    ): Promise<PreparedFeedbackTransaction> {
      const simulation = await simulate(input);
      const request = await (deps.walletClient as any).prepareTransactionRequest({
        account: deps.account,
        chain: deps.chain,
        to: registry(),
        data: encodeFeedbackCalldata(input),
        gas: simulation.request.gas,
      });
      const serializedTransaction = (await deps.account.signTransaction(
        request as any,
      )) as Hex;
      return {
        transactionHash: keccak256(serializedTransaction),
        serializedTransaction,
        nonce: BigInt(request.nonce),
      };
    },

    async submitPreparedFeedback(
      prepared: PreparedFeedbackTransaction,
      input: FeedbackInput,
      onBroadcast,
    ): Promise<FeedbackResult> {
      let hash: Hex;
      try {
        hash = await deps.walletClient.sendRawTransaction({
          serializedTransaction: prepared.serializedTransaction,
        });
      } catch (error) {
        if (!isAlreadyKnownTransaction(error)) throw error;
        hash = prepared.transactionHash;
      }
      if (hash.toLowerCase() !== prepared.transactionHash.toLowerCase()) {
        throw new Error("RPC returned an unexpected feedback transaction hash");
      }
      await onBroadcast?.(hash);
      const receipt = await deps.publicClient.waitForTransactionReceipt({
        hash,
      });
      return resultFromReceipt(hash, input, receipt);
    },

    async getFeedbackByTransaction(
      transactionHash: Hex,
      input: FeedbackInput,
    ): Promise<FeedbackResult | null> {
      try {
        const receipt = await deps.publicClient.getTransactionReceipt({
          hash: transactionHash,
        });
        if (receipt.status !== "success") {
          throw new FeedbackSubmissionError(
            "reverted",
            `giveFeedback transaction reverted (${transactionHash})`,
          );
        }
        return resultFromReceipt(transactionHash, input, receipt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("could not be found") ||
          message.includes("TransactionReceiptNotFound")
        ) {
          return null;
        }
        throw error;
      }
    },

    async getFacilitatorTransactionCount(): Promise<bigint> {
      return BigInt(
        await deps.publicClient.getTransactionCount({
          address: deps.account.address,
          // A pending nonce may belong to this exact prepared transaction.
          // Only a confirmed higher nonce proves that another transaction
          // consumed the stored nonce and the raw transaction must be rebuilt.
          blockTag: "latest",
        }),
      );
    },

    async revokeFeedback(
      agentId: bigint,
      feedbackIndex: bigint,
      onBroadcast,
    ): Promise<FeedbackResult> {
      let request;
      try {
        const simulation = await deps.publicClient.simulateContract({
          address: registry(),
          abi: [...reputationRegistryAbi, ...knownErrorAbis],
          functionName: "revokeFeedback",
          args: [agentId, feedbackIndex],
          account: deps.account,
          chain: deps.chain,
          gas: 150_000n,
        });
        request = simulation.request;
      } catch (error) {
        throw new Error(
          `revokeFeedback reverted: ${decodeRevertReason(error)}`,
        );
      }
      const hash = await deps.walletClient.writeContract(request);
      await onBroadcast?.(hash);
      const receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`revokeFeedback transaction reverted (${hash})`);
      }
      return { transactionHash: hash };
    },
  };
}
