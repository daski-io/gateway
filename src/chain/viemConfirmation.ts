import {
  decodeEventLog,
  parseAbiItem,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { base, baseSepolia } from "viem/chains";
import { easAbi, knownErrorAbis } from "./abis.js";
import type {
  ChainReader,
  ConfirmationDelegationInput,
  ConfirmationResult,
} from "./reader.js";
import type { Hex } from "../types.js";
import { decodeRevertReason } from "./viemErrors.js";

type SupportedChain = typeof base | typeof baseSepolia;
type ConfirmationMethods = Pick<
  ChainReader,
  "submitBuyerConfirmation" | "getEasAttesterNonce"
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
  return {
    async submitBuyerConfirmation(
      input: ConfirmationDelegationInput,
      onBroadcast,
    ): Promise<ConfirmationResult> {
      const delegation = {
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
      } as const;
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
        request = simulation.request;
      } catch (error) {
        throw new Error(
          `EAS.attestByDelegation reverted: ${decodeRevertReason(error)}`,
        );
      }
      const hash = await deps.walletClient.writeContract(request);
      await onBroadcast?.(hash);
      const receipt = await deps.publicClient.waitForTransactionReceipt({
        hash,
      });
      if (receipt.status !== "success") {
        throw new Error(
          `EAS.attestByDelegation reverted after simulation (tx ${hash})`,
        );
      }
      const uid = findAttestationUid(
        receipt.logs,
        deps.easAddress,
        input.attester,
        input.schema,
      );
      if (!uid) {
        throw new Error("EAS Attested event not found after delegation");
      }
      return { transactionHash: hash, attestationUid: uid };
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

function findAttestationUid(
  logs: readonly { address: Hex; data: Hex; topics: readonly Hex[] }[],
  easAddress: Hex,
  attester: Hex,
  schema: Hex,
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
        decoded.args.attester.toLowerCase() === attester.toLowerCase() &&
        decoded.args.schemaUID.toLowerCase() === schema.toLowerCase()
      ) {
        return decoded.args.uid;
      }
    } catch {
      // Other EAS events are irrelevant to this delegation.
    }
  }
  return null;
}
