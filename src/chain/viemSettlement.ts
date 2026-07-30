import {
  encodeFunctionData,
  keccak256,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import type { base, baseSepolia } from "viem/chains";
import type { Hex } from "../types.js";
import { knownErrorAbis, x402AdapterAbi } from "./abis.js";
import type {
  ChainReader,
  PreparedSettlementTransaction,
  SettleWithRegistrationInput,
  SettlementInput,
} from "./reader.js";
import {
  classifySettlementScreeningFailure,
  SettlementScreeningError,
} from "./sanctionsErrors.js";
import { decodeRevertReason } from "./viemErrors.js";
import { isAlreadyKnownTransaction } from "./transactionErrors.js";
import {
  registrationOccurred,
  settlementEventFromReceipt,
} from "./viemSettlementReceipt.js";

type SupportedChain = typeof base | typeof baseSepolia;
type SettlementMethods = Pick<
  ChainReader,
  | "prepareSettlement"
  | "prepareSettlementWithRegistration"
  | "submitPreparedSettlement"
  | "findSettlementByTransaction"
  | "getFacilitatorBalance"
  | "getFacilitatorTransactionCount"
  | "getFacilitatorPendingTransactionCount"
>;

export interface SettlementDeps {
  publicClient: PublicClient<Transport, SupportedChain>;
  walletClient: WalletClient<Transport, SupportedChain, PrivateKeyAccount>;
  account: PrivateKeyAccount;
  chain: SupportedChain;
  adapterAddress: Hex;
  agentIndexAddress: Hex;
  paymentRouterAddress: Hex;
  usdcAddress: Hex;
}

type SettlementFunction = "settle" | "settleWithRegistration";

export function createSettlementMethods(
  deps: SettlementDeps,
): SettlementMethods {
  const argsFor = (
    input: SettlementInput | SettleWithRegistrationInput,
    operation: SettlementFunction,
  ) => {
    const auth = {
      from: input.from,
      validAfter: input.validAfter,
      validBefore: input.validBefore,
      nonce: input.nonce,
      signature: input.signature,
    } as const;
    const common = [
      deps.usdcAddress,
      input.amount,
      input.serviceRef,
      input.providerAgentId,
      input.serviceId,
      input.expectedPayee,
      auth,
      input.nonceSalt,
    ] as const;
    if (operation === "settle") return common;
    const registration = (input as SettleWithRegistrationInput).registration;
    return [
      ...common,
      registration.agentURI,
      registration.deadline,
      registration.signature,
    ] as const;
  };

  const prepare = async (
    input: SettlementInput | SettleWithRegistrationInput,
    operation: SettlementFunction,
    facilitatorNonce: bigint,
  ): Promise<PreparedSettlementTransaction> => {
    const args = argsFor(input, operation);
    let simulation;
    try {
      simulation = await deps.publicClient.simulateContract({
        address: deps.adapterAddress,
        abi: [...x402AdapterAbi, ...knownErrorAbis],
        functionName: operation,
        args: args as any,
        account: deps.account,
        chain: deps.chain,
        gas: 2_000_000n,
      });
    } catch (error) {
      const screening = classifySettlementScreeningFailure(error);
      if (screening) {
        throw new SettlementScreeningError(screening, "simulation");
      }
      throw new Error(`${operation} reverted: ${decodeRevertReason(error)}`);
    }
    const request = await (deps.walletClient as any).prepareTransactionRequest({
      account: deps.account,
      chain: deps.chain,
      to: deps.adapterAddress,
      data: encodeFunctionData({
        abi: x402AdapterAbi,
        functionName: operation,
        args: args as any,
      }),
      gas: simulation.request.gas,
      nonce: facilitatorNonce,
    });
    const serializedTransaction = (await deps.account.signTransaction(
      request as any,
    )) as Hex;
    return {
      kind: operation === "settle" ? "settle" : "settle_with_registration",
      transactionHash: keccak256(serializedTransaction),
      serializedTransaction,
      facilitatorNonce: BigInt(request.nonce),
    };
  };

  const send = async (
    prepared: PreparedSettlementTransaction,
    onBroadcast?: (transactionHash: Hex) => Promise<void> | void,
  ): Promise<TransactionReceipt> => {
    let hash: Hex;
    try {
      hash = await deps.walletClient.sendRawTransaction({
        serializedTransaction: prepared.serializedTransaction,
      });
    } catch (error) {
      const screening = classifySettlementScreeningFailure(error);
      if (screening) {
        throw new SettlementScreeningError(screening, "submission");
      }
      if (!isAlreadyKnownTransaction(error)) throw error;
      hash = prepared.transactionHash;
    }
    if (hash.toLowerCase() !== prepared.transactionHash.toLowerCase()) {
      throw new Error("RPC returned an unexpected settlement transaction hash");
    }
    await onBroadcast?.(hash);
    return deps.publicClient.waitForTransactionReceipt({ hash });
  };

  return {
    async getFacilitatorBalance(): Promise<bigint> {
      return deps.publicClient.getBalance({
        address: deps.account.address,
        blockTag: "pending",
      });
    },

    prepareSettlement: (input, nonce) => prepare(input, "settle", nonce),
    prepareSettlementWithRegistration: (input, nonce) =>
      prepare(input, "settleWithRegistration", nonce),

    async submitPreparedSettlement(prepared, expectedServiceRef, onBroadcast) {
      const receipt = await send(prepared, onBroadcast);
      const result = await settlementEventFromReceipt(
        deps,
        prepared.transactionHash,
        expectedServiceRef,
        receipt,
      );
      if (prepared.kind === "settle") return result;
      const registered = registrationOccurred(deps, receipt);
      return {
        ...result,
        buyerAgentId: result.event.buyerAgentId,
        registered,
      };
    },

    async findSettlementByTransaction(transactionHash, serviceRef) {
      try {
        const receipt = await deps.publicClient.getTransactionReceipt({
          hash: transactionHash,
        });
        return settlementEventFromReceipt(
          deps,
          transactionHash,
          serviceRef,
          receipt,
        );
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
          blockTag: "latest",
        }),
      );
    },

    async getFacilitatorPendingTransactionCount(): Promise<bigint> {
      return BigInt(
        await deps.publicClient.getTransactionCount({
          address: deps.account.address,
          blockTag: "pending",
        }),
      );
    },
  };
}
