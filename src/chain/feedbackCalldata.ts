import { encodeFunctionData } from "viem";
import type { Hex } from "../types.js";
import { reputationRegistryAbi } from "./abis.js";
import type { FeedbackInput } from "./reader.js";

export const feedbackArgs = (input: FeedbackInput) =>
  [
    input.agentId,
    input.value,
    input.valueDecimals,
    input.tag1,
    input.tag2,
    input.endpoint,
    input.feedbackURI,
    input.feedbackHash,
  ] as const;

export function encodeFeedbackCalldata(input: FeedbackInput): Hex {
  return encodeFunctionData({
    abi: reputationRegistryAbi,
    functionName: "giveFeedback",
    args: feedbackArgs(input),
  });
}
