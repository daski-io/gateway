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
import {
  ConfirmationSubmitError,
  revertInvalidatesSignature,
} from "./confirmationErrors.js";
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
      // Stage 1 — pre-flight eth_call. A revert here broadcasts nothing and
      // consumes no attester nonce.
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
        const reason = decodeRevertReason(error);
        throw new ConfirmationSubmitError(
          "validation",
          `EAS.attestByDelegation reverted: ${reason}`,
          { needsFreshSignature: revertInvalidatesSignature(reason) },
        );
      }

      // Stage 2 — broadcast. Past this point we can no longer prove the
      // transaction is NOT in flight, so every failure is `unknown`.
      let hash: Hex;
      try {
        hash = await deps.walletClient.writeContract(request);
      } catch (error) {
        throw new ConfirmationSubmitError(
          "unknown",
          `EAS.attestByDelegation broadcast failed: ${decodeRevertReason(error)}`,
        );
      }
      await onBroadcast?.(hash);

      let receipt;
      try {
        receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
      } catch (error) {
        throw new ConfirmationSubmitError(
          "unknown",
          `EAS.attestByDelegation receipt unavailable: ${decodeRevertReason(error)}`,
          { transactionHash: hash },
        );
      }
      if (receipt.status !== "success") {
        throw new ConfirmationSubmitError(
          "reverted",
          `EAS.attestByDelegation reverted after simulation (tx ${hash})`,
          { transactionHash: hash },
        );
      }

      // Stage 3 — the attestation EXISTS on-chain and the nonce is spent.
      // Losing the UID here is data loss, not a failed confirmation, so the
      // strict (attester, schema) match falls back to any Attested event
      // this EAS emitted in our own receipt — attestByDelegation emits
      // exactly one.
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
          `EAS Attested event not found in a successful attestByDelegation receipt (tx ${hash})`,
          { transactionHash: hash },
        );
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
