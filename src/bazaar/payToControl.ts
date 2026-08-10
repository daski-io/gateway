import {
  parseSignature,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import type { BazaarListing } from "./types.js";

export const PAY_TO_CONTROL_TYPES = {
  DaskiBazaarPayToControl: [
    { name: "providerAgentId", type: "uint256" },
    { name: "listingEpoch", type: "bytes32" },
    { name: "listingCommitment", type: "bytes32" },
    { name: "payTo", type: "address" },
    { name: "validBefore", type: "uint256" },
  ],
} as const;
const HALF_SECP256K1_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export function payToControlTypedData(listing: BazaarListing) {
  const offer = listing.offer.message;
  return {
    domain: {
      name: "Daski Bazaar PayTo Control",
      version: "1",
      chainId: offer.chainId,
      verifyingContract: offer.payTo,
    },
    types: PAY_TO_CONTROL_TYPES,
    primaryType: "DaskiBazaarPayToControl" as const,
    message: {
      providerAgentId: offer.providerAgentId,
      listingEpoch: offer.listingEpoch,
      listingCommitment: offer.listingCommitment,
      payTo: offer.payTo,
      validBefore: listing.payToControlProof.validBefore,
    },
  };
}

export async function validatePayToControlProof(listing: BazaarListing): Promise<void> {
  const proof = listing.payToControlProof;
  if (
    typeof proof.validBefore !== "bigint" ||
    proof.validBefore !== listing.offer.message.validBefore ||
    !/^0x[0-9a-fA-F]{130}$/.test(proof.signature)
  ) throw new Error("Bazaar payTo control proof is malformed or stale");
  const parsed = parseSignature(proof.signature);
  if (BigInt(parsed.s) > HALF_SECP256K1_N) {
    throw new Error("Bazaar payTo control proof is not canonical low-s");
  }
  const signer = await recoverTypedDataAddress({
    ...payToControlTypedData(listing),
    signature: proof.signature as Hex,
  });
  if (signer.toLowerCase() !== listing.offer.message.payTo.toLowerCase()) {
    throw new Error("Bazaar payTo control proof does not match the recipient");
  }
}
