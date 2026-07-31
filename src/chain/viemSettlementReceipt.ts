import {
  parseEventLogs,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
} from "viem";
import type { base, baseSepolia } from "viem/chains";
import type { Hex } from "../types.js";
import { agentIndexAbi, paymentRouterAbi } from "./abis.js";
import type { PaymentSettledEvent, SettlementResult } from "./reader.js";
import { SettlementTransactionRevertedError } from "./reader.js";
import {
  classifySettlementScreeningFailure,
  SettlementScreeningError,
} from "./sanctionsErrors.js";

type SupportedChain = typeof base | typeof baseSepolia;

export interface SettlementReceiptDeps {
  publicClient: PublicClient<Transport, SupportedChain>;
  account: PrivateKeyAccount;
  agentIndexAddress: Hex;
  paymentRouterAddress: Hex;
}

export async function settlementEventFromReceipt(
  deps: SettlementReceiptDeps,
  transactionHash: Hex,
  serviceRef: Hex,
  receipt: TransactionReceipt,
): Promise<SettlementResult> {
  if (receipt.status !== "success") {
    throw await classifyRevertedSettlement(
      deps,
      transactionHash,
      receipt.blockNumber,
    );
  }
  const parsed = parseEventLogs({
    abi: paymentRouterAbi,
    eventName: "PaymentSettled",
    logs: receipt.logs.filter(
      (log) =>
        log.address.toLowerCase() === deps.paymentRouterAddress.toLowerCase(),
    ) as any,
  });
  const match = parsed.find(
    (event: any) =>
      String(event.args.serviceRef).toLowerCase() === serviceRef.toLowerCase(),
  );
  if (!match) {
    throw new Error("PaymentSettled event missing from transaction");
  }
  return {
    transactionHash,
    event: (match as any).args as PaymentSettledEvent,
  };
}

export function registrationOccurred(
  deps: SettlementReceiptDeps,
  receipt: TransactionReceipt,
): boolean {
  return (
    parseEventLogs({
      abi: agentIndexAbi,
      eventName: "AgentRegistered",
      logs: receipt.logs.filter(
        (log) =>
          log.address.toLowerCase() === deps.agentIndexAddress.toLowerCase(),
      ) as any,
    }).length > 0
  );
}

async function classifyRevertedSettlement(
  deps: SettlementReceiptDeps,
  transactionHash: Hex,
  blockNumber: bigint,
): Promise<Error> {
  try {
    const transaction = await deps.publicClient.getTransaction({
      hash: transactionHash,
    });
    if (!transaction.to) {
      return new SettlementTransactionRevertedError(transactionHash);
    }
    await deps.publicClient.call({
      account: transaction.from,
      to: transaction.to,
      data: transaction.input,
      value: transaction.value,
      blockNumber,
    });
  } catch (error) {
    const screening = classifySettlementScreeningFailure(error);
    if (screening) {
      return new SettlementScreeningError(
        screening,
        "receipt_replay",
        transactionHash,
      );
    }
  }
  return new SettlementTransactionRevertedError(transactionHash);
}
