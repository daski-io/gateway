import type {
  PrivateKeyAccount,
  PublicClient,
  Transport,
  WalletClient,
} from "viem";
import type { base, baseSepolia } from "viem/chains";
import { knownErrorAbis, reputationRegistryAbi } from "./abis.js";
import type { ChainReader, FeedbackInput, FeedbackResult } from "./reader.js";
import type { Hex } from "../types.js";
import { decodeRevertReason } from "./viemErrors.js";

type SupportedChain = typeof base | typeof baseSepolia;
type FeedbackMethods = Pick<
  ChainReader,
  "giveFeedback" | "revokeFeedback" | "getFeedbackLastIndex"
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

  const send = async (
    request: Parameters<typeof deps.walletClient.writeContract>[0],
    action: string,
  ): Promise<FeedbackResult> => {
    const hash = await deps.walletClient.writeContract(request);
    const receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(
        `${action} reverted on broadcast despite passing simulation (tx ${hash})`,
      );
    }
    return { transactionHash: hash };
  };

  return {
    async giveFeedback(input: FeedbackInput): Promise<FeedbackResult> {
      let request;
      try {
        const simulation = await deps.publicClient.simulateContract({
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
        request = simulation.request;
      } catch (error) {
        throw new Error(
          `giveFeedback reverted: ${decodeRevertReason(error)}`,
        );
      }
      return send(request, "giveFeedback");
    },

    async revokeFeedback(
      agentId: bigint,
      feedbackIndex: bigint,
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
      return send(request, "revokeFeedback");
    },

    async getFeedbackLastIndex(agentId: bigint): Promise<bigint> {
      return (await deps.publicClient.readContract({
        address: registry(),
        abi: reputationRegistryAbi,
        functionName: "getLastIndex",
        args: [agentId, deps.account.address],
      })) as bigint;
    },
  };
}
