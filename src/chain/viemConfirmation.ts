import {
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  parseAbiItem,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import type { base, baseSepolia } from "viem/chains";
import { easAbi, knownErrorAbis } from "./abis.js";
import type {
  ChainReader,
  ConfirmationDelegationInput,
  PreparedConfirmationTransaction,
  ConfirmationResult,
} from "./reader.js";
import type { Hex } from "../types.js";
import {
  ConfirmationSubmitError,
  revertInvalidatesSignature,
} from "./confirmationErrors.js";
import { decodeRevertReason } from "./viemErrors.js";
import { isAlreadyKnownTransaction } from "./transactionErrors.js";
import { FACILITATOR_WRITE_CONFIRMATIONS } from "./transactionFinality.js";

type SupportedChain = typeof base | typeof baseSepolia;
type ConfirmationMethods = Pick<
  ChainReader,
  | "prepareBuyerConfirmation"
  | "submitPreparedBuyerConfirmation"
  | "getBuyerConfirmationByTransaction"
  | "getEasAttesterNonce"
>;

export interface ConfirmationDeps {
  publicClient: PublicClient<Transport, SupportedChain>;
  walletClient: WalletClient<Transport, SupportedChain, PrivateKeyAccount>;
  account: PrivateKeyAccount;
  chain: SupportedChain;
  easAddress: Hex;
}

const EAS_ATTESTED_EVENT = parseAbiItem(
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
);

export function createConfirmationMethods(
  deps: ConfirmationDeps,
): ConfirmationMethods {
  const delegationFor = (input: ConfirmationDelegationInput) => ({
    schema: input.schema,
    data: {
      recipient: input.recipient,
      expirationTime: input.expirationTime,
      revocable: input.revocable,
      refUID: input.refUID,
      data: input.data,
      value: input.value,
    },
    signature: input.signature,
    attester: input.attester,
    deadline: input.deadline,
  });

  const resultFromReceipt = (
    transactionHash: Hex,
    input: ConfirmationDelegationInput,
    receipt: TransactionReceipt,
  ): ConfirmationResult => {
    if (receipt.status !== "success") {
      throw new ConfirmationSubmitError(
        "reverted",
        `EAS.attestByDelegation reverted after simulation (tx ${transactionHash})`,
        { transactionHash },
      );
    }
    const uid =
      findAttestationUid(
        receipt.logs,
        deps.easAddress,
        input.attester,
        input.schema,
      ) ?? findAttestationUid(receipt.logs, deps.easAddress);
    if (!uid) {
      throw new ConfirmationSubmitError(
        "attestation",
        `EAS Attested event not found in a successful attestByDelegation receipt (tx ${transactionHash})`,
        { transactionHash },
      );
    }
    return { transactionHash, attestationUid: uid };
  };

  return {
    async prepareBuyerConfirmation(
      input: ConfirmationDelegationInput,
      facilitatorNonce: bigint,
    ): Promise<PreparedConfirmationTransaction> {
      const delegation = delegationFor(input);
      let request;
      try {
        const simulation = await deps.publicClient.simulateContract({
          address: deps.easAddress,
          abi: [...easAbi, ...knownErrorAbis],
          functionName: "attestByDelegation",
          args: [delegation],
          account: deps.account,
          chain: deps.chain,
          gas: 600_000n,
        });
        request = await (deps.walletClient as any).prepareTransactionRequest({
          account: deps.account,
          chain: deps.chain,
          to: deps.easAddress,
          data: encodeFunctionData({
            abi: easAbi,
            functionName: "attestByDelegation",
            args: [delegation],
          }),
          gas: simulation.request.gas,
          nonce: facilitatorNonce,
        });
      } catch (error) {
        const reason = decodeRevertReason(error);
        throw new ConfirmationSubmitError(
          "validation",
          `EAS.attestByDelegation reverted: ${reason}`,
          { needsFreshSignature: revertInvalidatesSignature(reason) },
        );
      }
      const serializedTransaction = (await deps.account.signTransaction(
        request as any,
      )) as Hex;
      return {
        transactionHash: keccak256(serializedTransaction),
        serializedTransaction,
        facilitatorNonce,
      };
    },

    async submitPreparedBuyerConfirmation(
      prepared,
      input,
      onBroadcast,
    ): Promise<ConfirmationResult> {
      let hash: Hex;
      try {
        hash = await deps.walletClient.sendRawTransaction({
          serializedTransaction: prepared.serializedTransaction,
        });
      } catch (error) {
        if (isAlreadyKnownTransaction(error)) {
          hash = prepared.transactionHash;
        } else {
          throw new ConfirmationSubmitError(
            "unknown",
            `EAS.attestByDelegation broadcast failed: ${decodeRevertReason(error)}`,
            { transactionHash: prepared.transactionHash },
          );
        }
      }
      if (hash.toLowerCase() !== prepared.transactionHash.toLowerCase()) {
        throw new ConfirmationSubmitError(
          "unknown",
          "RPC returned an unexpected confirmation transaction hash",
          { transactionHash: prepared.transactionHash },
        );
      }
      await onBroadcast?.(hash);
      let receipt;
      try {
        receipt = await deps.publicClient.waitForTransactionReceipt({
          hash,
          confirmations: FACILITATOR_WRITE_CONFIRMATIONS,
        });
      } catch (error) {
        throw new ConfirmationSubmitError(
          "unknown",
          `EAS.attestByDelegation receipt unavailable: ${decodeRevertReason(error)}`,
          { transactionHash: hash },
        );
      }
      return resultFromReceipt(hash, input, receipt);
    },

    async getBuyerConfirmationByTransaction(transactionHash, input) {
      try {
        const receipt = await deps.publicClient.getTransactionReceipt({
          hash: transactionHash,
        });
        const confirmations =
          await deps.publicClient.getTransactionConfirmations({
            transactionReceipt: receipt,
          });
        if (confirmations < BigInt(FACILITATOR_WRITE_CONFIRMATIONS)) return null;
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

    async getEasAttesterNonce(attester: Hex): Promise<bigint> {
      return (await deps.publicClient.readContract({
        address: deps.easAddress,
        abi: easAbi,
        functionName: "getNonce",
        args: [attester],
      })) as bigint;
    },
  };
}

/** Attester/schema are optional: omitting them relaxes the search to any
 *  Attested event from this EAS, the recovery path for a receipt we know
 *  succeeded. */
function findAttestationUid(
  logs: readonly { address: Hex; data: Hex; topics: readonly Hex[] }[],
  easAddress: Hex,
  attester?: Hex,
  schema?: Hex,
): Hex | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== easAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [EAS_ATTESTED_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      }) as { args: { uid: Hex; attester: Hex; schemaUID: Hex } };
      if (
        (attester === undefined ||
          decoded.args.attester.toLowerCase() === attester.toLowerCase()) &&
        (schema === undefined ||
          decoded.args.schemaUID.toLowerCase() === schema.toLowerCase())
      ) {
        return decoded.args.uid;
      }
    } catch {
      // Other EAS events are irrelevant to this delegation.
    }
  }
  return null;
}
