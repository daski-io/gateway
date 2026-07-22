import {
  keccak256,
  parseEventLogs,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { base, baseSepolia } from "viem/chains";
import type { Hex } from "../types.js";
import { knownErrorAbis, reputationRegistryAbi } from "./abis.js";
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
  ): Promise<FeedbackResult> => {
    const receipt = await deps.publicClient.waitForTransactionReceipt({
      hash: transactionHash,
    });
    if (receipt.status !== "success") {
      throw new Error(`giveFeedback transaction reverted (${transactionHash})`);
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
      throw new Error(
        `NewFeedback event missing from transaction ${transactionHash}`,
      );
    }
    return {
      transactionHash,
      feedbackIndex: (match as any).args.feedbackIndex as bigint,
    };
  };

  const simulate = async (input: FeedbackInput) => {
    try {
      return await deps.publicClient.simulateContract({
        address: registry(),
        abi: [...reputationRegistryAbi, ...knownErrorAbis],
        functionName: "giveFeedback",
        args: [
          input.agentId,
          input.value,
          input.valueDecimals,
          input.tag1,
          input.tag2,
          input.endpoint,
          input.feedbackURI,
          input.feedbackHash,
        ],
        account: deps.account,
        chain: deps.chain,
        gas: 300_000n,
      });
    } catch (error) {
      throw new Error(`giveFeedback reverted: ${decodeRevertReason(error)}`);
    }
  };

  return {
    async prepareFeedback(
      input: FeedbackInput,
    ): Promise<PreparedFeedbackTransaction> {
      const simulation = await simulate(input);
      const request = await (deps.walletClient as any).prepareTransactionRequest({
        ...simulation.request,
        account: deps.account,
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
      const hash = await deps.walletClient.sendRawTransaction({
        serializedTransaction: prepared.serializedTransaction,
      });
      if (hash.toLowerCase() !== prepared.transactionHash.toLowerCase()) {
        throw new Error("RPC returned an unexpected feedback transaction hash");
      }
      await onBroadcast?.(hash);
      return resultFromReceipt(hash, input);
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
          throw new Error(`giveFeedback transaction reverted (${transactionHash})`);
        }
        return resultFromReceipt(transactionHash, input);
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
