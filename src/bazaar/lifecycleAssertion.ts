import {
  keccak256,
  parseSignature,
  recoverTypedDataAddress,
  toBytes,
  type Hex,
} from "viem";
import type {
  BazaarLifecycleAction,
  BazaarProviderActionSigningBroker,
  BazaarOrder,
} from "./types.js";

export const LIFECYCLE_ACTION_TYPES = {
  DaskiBazaarLifecycleAction: [
    { name: "orderRecordId", type: "bytes32" },
    { name: "taskIdHash", type: "bytes32" },
    { name: "providerAgentId", type: "uint256" },
    { name: "actionHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "buyerAuthorizationDigest", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;
const HALF_SECP256K1_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export async function createProviderLifecycleAssertion(input: {
  order: BazaarOrder;
  action: BazaarLifecycleAction;
  requestHash: Hex;
  taskIdHash: Hex;
  nonce: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
  signer: BazaarProviderActionSigningBroker;
}) {
  const typed = {
    domain: {
      name: "Daski Bazaar Lifecycle Action",
      version: "1",
      chainId: input.order.chainId.toString(),
      verifyingContract: input.order.payTo,
    },
    types: LIFECYCLE_ACTION_TYPES,
    primaryType: "DaskiBazaarLifecycleAction" as const,
    message: {
      orderRecordId: input.order.orderRecordId,
      taskIdHash: input.taskIdHash,
      providerAgentId: input.order.providerAgentId.toString(),
      actionHash: keccak256(toBytes(input.action)),
      requestHash: input.requestHash,
      buyerAuthorizationDigest: input.order.authorizationDigest,
      nonce: input.nonce,
      issuedAt: input.issuedAt.toString(),
      expiresAt: input.expiresAt.toString(),
    },
  };
  const signingData = {
    ...typed,
    domain: { ...typed.domain, chainId: input.order.chainId },
    message: {
      ...typed.message,
      providerAgentId: input.order.providerAgentId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    },
  };
  const signature = await input.signer.signLifecycleAction({
    chainId: typed.domain.chainId,
    payTo: typed.domain.verifyingContract,
    message: typed.message,
  });
  if (
    !/^0x[0-9a-fA-F]{130}$/.test(signature) ||
    BigInt(parseSignature(signature).s) > HALF_SECP256K1_N
  ) throw new Error("Bazaar provider-action signer returned a malformed signature");
  const recovered = await recoverTypedDataAddress({ ...signingData, signature });
  if (recovered.toLowerCase() !== input.signer.address.toLowerCase()) {
    throw new Error("Bazaar provider-action signer returned the wrong signature");
  }
  return { ...typed, signature };
}
