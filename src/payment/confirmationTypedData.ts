import type { Config } from "../config.js";
import type { Eip712TypedData, Hex } from "../types.js";

export const CONFIRMATION_ATTEST_TYPES = {
  Attest: [
    { name: "schema", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "expirationTime", type: "uint64" },
    { name: "revocable", type: "bool" },
    { name: "refUID", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export function confirmationTypedData(
  config: Pick<Config, "chainId" | "easAddress" | "easConfirmationSchemaUid">,
  input: {
    recipient: Hex;
    refUid: Hex;
    data: Hex;
    easNonce: bigint;
    deadline: bigint;
  },
): Eip712TypedData {
  return {
    domain: {
      name: "EAS",
      version: "1.2.0",
      chainId: config.chainId,
      verifyingContract: config.easAddress,
    },
    types: {
      Attest: CONFIRMATION_ATTEST_TYPES.Attest.map((field) => ({
        name: field.name,
        type: field.type,
      })),
    },
    primaryType: "Attest",
    message: {
      schema: config.easConfirmationSchemaUid,
      recipient: input.recipient,
      expirationTime: "0",
      revocable: true,
      refUID: input.refUid,
      data: input.data,
      value: "0",
      nonce: input.easNonce.toString(),
      deadline: input.deadline.toString(),
    },
  };
}
