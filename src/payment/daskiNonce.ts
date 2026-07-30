import {
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Address,
} from "viem";
import type { Hex } from "../types.js";

export const DASKI_RECEIVE_NONCE_DOMAIN = keccak256(
  toBytes("DASKI_X402_RECEIVE_V1"),
);

export interface DaskiReceiveNonceInput {
  chainId: number;
  adapter: Address;
  router: Address;
  token: Address;
  payer: Address;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  providerAgentId: bigint;
  serviceId: Hex;
  expectedPayee: Address;
  serviceRef: Hex;
  nonceSalt: Hex;
}

/** Mirrors X402Adapter.authNonceFor exactly. */
export function deriveDaskiReceiveNonce(
  input: DaskiReceiveNonceInput,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        DASKI_RECEIVE_NONCE_DOMAIN,
        BigInt(input.chainId),
        input.adapter,
        input.router,
        input.token,
        input.payer,
        input.amount,
        input.validAfter,
        input.validBefore,
        input.providerAgentId,
        input.serviceId,
        input.expectedPayee,
        input.serviceRef,
        input.nonceSalt,
      ],
    ),
  );
}
