import type { PublicClient, Transport } from "viem";
import type { base, baseSepolia } from "viem/chains";
import { reputationStorageAbi } from "./abis.js";
import type {
  BuyerConfirmationLabel,
  ChainReader,
  TransactionOutcome,
} from "./reader.js";
import type { Hex } from "../types.js";

type ReputationReadMethods = Pick<
  ChainReader,
  | "getProviderReputation"
  | "getBuyerReputation"
  | "getServiceReputation"
  | "getReputationRecord"
>;

const OUTCOME_LABELS: Record<number, TransactionOutcome> = {
  0: "Completed",
  1: "Failed",
  2: "Canceled",
};

const CONFIRMATION_LABELS: Record<number, BuyerConfirmationLabel> = {
  0: "Pending",
  1: "Confirmed",
  2: "NotConfirmed",
};

export function createReputationReadMethods(
  publicClient: PublicClient<Transport, typeof base | typeof baseSepolia>,
  reputationStorageAddress?: Hex,
): ReputationReadMethods {
  return {
    async getProviderReputation(agentId: bigint) {
      if (!reputationStorageAddress) return null;
      const result = (await publicClient.readContract({
        address: reputationStorageAddress,
        abi: reputationStorageAbi,
        functionName: "getProviderStats",
        args: [agentId],
      })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
      return {
        completed: result[0],
        failed: result[1],
        canceled: result[2],
        confirmed: result[3],
        notConfirmed: result[4],
      };
    },

    async getBuyerReputation(agentId: bigint) {
      if (!reputationStorageAddress) return null;
      const result = (await publicClient.readContract({
        address: reputationStorageAddress,
        abi: reputationStorageAbi,
        functionName: "getBuyerStats",
        args: [agentId],
      })) as readonly [bigint, bigint, bigint];
      return {
        transactions: result[0],
        confirmed: result[1],
        notConfirmed: result[2],
      };
    },

    async getServiceReputation(serviceId: Hex) {
      if (!reputationStorageAddress) return null;
      const result = (await publicClient.readContract({
        address: reputationStorageAddress,
        abi: reputationStorageAbi,
        functionName: "getServiceStats",
        args: [serviceId],
      })) as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      return {
        completed: result[0],
        failed: result[1],
        canceled: result[2],
        confirmed: result[3],
        notConfirmed: result[4],
        totalRefunded: result[5],
      };
    },

    async getReputationRecord(paymentId: bigint) {
      if (!reputationStorageAddress) return null;
      const raw = (await publicClient.readContract({
        address: reputationStorageAddress,
        abi: reputationStorageAbi,
        functionName: "getRecord",
        args: [paymentId],
      })) as {
        paymentId: bigint;
        providerAgentId: bigint;
        buyerAgentId: bigint;
        serviceId: Hex;
        outcome: number;
        confirmation: number;
        fulfillmentTime: bigint;
        outcomeTimestamp: bigint;
        confirmationTimestamp: bigint;
        outcomeRecorded: boolean;
        currentConfirmationUid: Hex;
        reputationEligible: boolean;
      };
      if (raw.paymentId === 0n) return null;
      return {
        paymentId: raw.paymentId,
        providerAgentId: raw.providerAgentId,
        buyerAgentId: raw.buyerAgentId,
        serviceId: raw.serviceId,
        outcome: raw.outcomeRecorded
          ? OUTCOME_LABELS[raw.outcome] ?? null
          : null,
        confirmation: CONFIRMATION_LABELS[raw.confirmation] ?? "Pending",
        fulfillmentSeconds: raw.outcomeRecorded ? raw.fulfillmentTime : null,
        outcomeTimestamp: raw.outcomeTimestamp,
        confirmationTimestamp: raw.confirmationTimestamp,
        outcomeRecorded: raw.outcomeRecorded,
        reputationEligible: raw.reputationEligible,
      };
    },
  };
}
