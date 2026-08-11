import {
  parseSignature,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import type { BazaarListing } from "./types.js";

export const FULFILLMENT_SIGNER_CONTROL_TYPES = {
  DaskiBazaarFulfillmentSignerControl: [
    { name: "providerAgentId", type: "uint256" },
    { name: "listingEpoch", type: "bytes32" },
    { name: "listingCommitment", type: "bytes32" },
    { name: "fulfillmentSigner", type: "address" },
    { name: "validBefore", type: "uint256" },
  ],
} as const;

const HALF_SECP256K1_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export function fulfillmentSignerControlTypedData(listing: BazaarListing) {
  const offer = listing.offer.message;
  return {
    domain: {
      name: "Daski Bazaar Fulfillment Signer Control",
      version: "1",
      chainId: offer.chainId,
      verifyingContract: offer.payTo,
    },
    types: FULFILLMENT_SIGNER_CONTROL_TYPES,
    primaryType: "DaskiBazaarFulfillmentSignerControl" as const,
    message: {
      providerAgentId: offer.providerAgentId,
      listingEpoch: offer.listingEpoch,
      listingCommitment: offer.listingCommitment,
      fulfillmentSigner: offer.fulfillmentSigner,
      validBefore: listing.fulfillmentSignerControlProof.validBefore,
    },
  };
}

export async function validateFulfillmentSignerControlProof(
  listing: BazaarListing,
): Promise<void> {
  const proof = listing.fulfillmentSignerControlProof;
  if (
    typeof proof.validBefore !== "bigint" ||
    proof.validBefore !== listing.offer.message.validBefore ||
    !/^0x[0-9a-fA-F]{130}$/.test(proof.signature)
  ) throw new Error("Bazaar fulfillment-signer proof is malformed or stale");
  if (BigInt(parseSignature(proof.signature).s) > HALF_SECP256K1_N) {
    throw new Error("Bazaar fulfillment-signer proof is not canonical low-s");
  }
  const signer = await recoverTypedDataAddress({
    ...fulfillmentSignerControlTypedData(listing),
    signature: proof.signature as Hex,
  });
  if (signer.toLowerCase() !== listing.offer.message.fulfillmentSigner.toLowerCase()) {
    throw new Error("Bazaar fulfillment-signer proof does not match its authority");
  }
}
