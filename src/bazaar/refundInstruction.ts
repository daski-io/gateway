import {
  encodeAbiParameters,
  keccak256,
  parseSignature,
  recoverTypedDataAddress,
  toBytes,
  type Hex,
} from "viem";
import type {
  BazaarRefundInstructionSigningBroker,
  BazaarRefundReason,
} from "./types.js";

export const BAZAAR_REFUND_INSTRUCTION_TYPES = {
  DaskiBazaarRefundInstruction: [
    { name: "orderRecordId", type: "bytes32" },
    { name: "refundId", type: "bytes32" },
    { name: "authorizationDigest", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "token", type: "address" },
    { name: "grossAmount", type: "uint256" },
    { name: "refundReason", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "instructionNonce", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

const INSTRUCTION_NONCE_DOMAIN = keccak256(
  toBytes("DASKI_BAZAAR_REFUND_INSTRUCTION_NONCE_V1"),
);
const HALF_SECP256K1_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export async function createBazaarRefundInstruction(input: {
  chainId: bigint;
  payTo: Hex;
  orderRecordId: Hex;
  refundId: Hex;
  authorizationDigest: Hex;
  payer: Hex;
  token: Hex;
  grossAmount: bigint;
  refundReason: BazaarRefundReason;
  evidenceHash: Hex;
  attemptCount: number;
  issuedAt: bigint;
  expiresAt: bigint;
  signer: BazaarRefundInstructionSigningBroker;
}) {
  const instructionNonce = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
    [INSTRUCTION_NONCE_DOMAIN, input.refundId, BigInt(input.attemptCount)],
  ));
  const typed = {
    domain: {
      name: "Daski Bazaar Refund Instruction",
      version: "1",
      chainId: input.chainId.toString(),
      verifyingContract: input.payTo,
    },
    types: BAZAAR_REFUND_INSTRUCTION_TYPES,
    primaryType: "DaskiBazaarRefundInstruction" as const,
    message: {
      orderRecordId: input.orderRecordId,
      refundId: input.refundId,
      authorizationDigest: input.authorizationDigest,
      payer: input.payer,
      token: input.token,
      grossAmount: input.grossAmount.toString(),
      refundReason: keccak256(toBytes(input.refundReason)),
      evidenceHash: input.evidenceHash,
      instructionNonce,
      issuedAt: input.issuedAt.toString(),
      expiresAt: input.expiresAt.toString(),
    },
  };
  const signature = await input.signer.signRefundInstruction({
    chainId: typed.domain.chainId,
    payTo: typed.domain.verifyingContract,
    message: typed.message,
  });
  if (
    !/^0x[0-9a-fA-F]{130}$/.test(signature) ||
    BigInt(parseSignature(signature).s) > HALF_SECP256K1_N
  ) throw new Error("Bazaar refund signer returned a malformed signature");
  const recovered = await recoverTypedDataAddress({
    ...typed,
    domain: { ...typed.domain, chainId: input.chainId },
    message: {
      ...typed.message,
      grossAmount: input.grossAmount,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    },
    signature,
  });
  if (recovered.toLowerCase() !== input.signer.address.toLowerCase()) {
    throw new Error("Bazaar refund signer returned the wrong signature");
  }
  return { ...typed, signature };
}
