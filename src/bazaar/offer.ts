import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  parseSignature,
  recoverTypedDataAddress,
  toBytes,
  type Hex,
} from "viem";
import { validateListingManifest } from "./listingManifest.js";
import { PAYMENT_MAX_TIMEOUT_SECONDS } from "./paymentPolicy.js";
import { validatePayToControlProof } from "./payToControl.js";
import type { BazaarListing, ListingOfferV1 } from "./types.js";

export const LISTING_OFFER_V1_TYPES = {
  ListingOfferV1: [
    { name: "chainId", type: "uint256" },
    { name: "listingEpoch", type: "bytes32" },
    { name: "listingCommitment", type: "bytes32" },
    { name: "providerAgentId", type: "uint256" },
    { name: "offerSigner", type: "address" },
    { name: "providerPayee", type: "address" },
    { name: "outcomeId", type: "bytes32" },
    { name: "methodHash", type: "bytes32" },
    { name: "resourceHash", type: "bytes32" },
    { name: "requestSchemaHash", type: "bytes32" },
    { name: "responseSchemaHash", type: "bytes32" },
    { name: "requestBindingModeHash", type: "bytes32" },
    { name: "routeModeHash", type: "bytes32" },
    { name: "token", type: "address" },
    { name: "grossAmount", type: "uint256" },
    { name: "payTo", type: "address" },
    { name: "paymentMaxTimeoutSeconds", type: "uint256" },
    { name: "daskiCommissionReceiver", type: "address" },
    { name: "commissionBps", type: "uint256" },
    { name: "splitterCodeHash", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "policyVersion", type: "bytes32" },
    { name: "offerId", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
} as const;

const LISTING_COMMITMENT_TYPEHASH = keccak256(
  toBytes(
    "DaskiBazaarListingCommitment(uint256 chainId,bytes32 listingEpoch,uint256 providerAgentId,address providerPayee,bytes32 outcomeId,bytes32 methodHash,bytes32 resourceHash,bytes32 requestSchemaHash,bytes32 responseSchemaHash,bytes32 requestBindingModeHash,bytes32 routeModeHash,address token,uint256 grossAmount,uint256 paymentMaxTimeoutSeconds,address daskiCommissionReceiver,uint256 commissionBps,bytes32 splitterCodeHash,bytes32 termsHash,bytes32 policyVersion)",
  ),
);
const ZERO_ADDRESS = `0x${"00".repeat(20)}` as Hex;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const HALF_SECP256K1_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const MAX_UINT256 = (1n << 256n) - 1n;

export function listingOfferDomain(message: ListingOfferV1) {
  return {
    name: "Daski Bazaar Listing Offer",
    version: "1",
    chainId: message.chainId,
    verifyingContract: message.payTo,
  } as const;
}

export function listingOfferHash(message: ListingOfferV1): Hex {
  return hashTypedData({
    domain: listingOfferDomain(message),
    types: LISTING_OFFER_V1_TYPES,
    primaryType: "ListingOfferV1",
    message,
  });
}

export function computeListingCommitment(message: ListingOfferV1): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" },
        { type: "uint256" }, { type: "address" }, { type: "bytes32" },
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
        { type: "address" }, { type: "uint256" }, { type: "uint256" },
        { type: "address" }, { type: "uint256" }, { type: "bytes32" },
        { type: "bytes32" }, { type: "bytes32" },
      ],
      [
        LISTING_COMMITMENT_TYPEHASH, message.chainId, message.listingEpoch,
        message.providerAgentId, message.providerPayee, message.outcomeId,
        message.methodHash, message.resourceHash, message.requestSchemaHash,
        message.responseSchemaHash, message.requestBindingModeHash,
        message.routeModeHash, message.token, message.grossAmount,
        message.paymentMaxTimeoutSeconds, message.daskiCommissionReceiver,
        message.commissionBps, message.splitterCodeHash,
        message.termsHash, message.policyVersion,
      ],
    ),
  );
}

export async function validateCompatibilityListing(
  listing: BazaarListing,
  nowSeconds: bigint,
  maxOfferLifetimeSeconds = 30n * 24n * 60n * 60n,
): Promise<void> {
  const message = listing.offer.message;
  validateListingManifest(listing, message);
  await validatePayToControlProof(listing);
  const uints = [
    message.chainId, message.providerAgentId, message.grossAmount,
    message.paymentMaxTimeoutSeconds, message.commissionBps, message.issuedAt,
    message.validBefore,
  ];
  if (
    uints.some((value) => typeof value !== "bigint" || value < 0n || value > MAX_UINT256) ||
    message.grossAmount <= 0n ||
    message.providerAgentId <= 0n ||
    message.paymentMaxTimeoutSeconds !== PAYMENT_MAX_TIMEOUT_SECONDS ||
    message.issuedAt > nowSeconds ||
    message.validBefore <= nowSeconds ||
    message.validBefore - message.issuedAt > maxOfferLifetimeSeconds
  ) {
    throw new Error("Bazaar listing offer has an invalid amount or time window");
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(listing.offer.signature)) {
    throw new Error("Bazaar listing offer signature is malformed");
  }
  if (
    message.providerPayee.toLowerCase() !== message.payTo.toLowerCase() ||
    message.daskiCommissionReceiver.toLowerCase() !== ZERO_ADDRESS ||
    message.commissionBps !== 0n ||
    message.splitterCodeHash.toLowerCase() !== ZERO_BYTES32
  ) {
    throw new Error("compatibility listing must pay its provider directly");
  }
  if (computeListingCommitment(message) !== message.listingCommitment) {
    throw new Error("Bazaar listing commitment does not match its terms");
  }
  const parsed = parseSignature(listing.offer.signature);
  if (BigInt(parsed.s) > HALF_SECP256K1_N) {
    throw new Error("Bazaar listing offer signature is not canonical low-s");
  }
  const signer = await recoverTypedDataAddress({
    domain: listingOfferDomain(message),
    types: LISTING_OFFER_V1_TYPES,
    primaryType: "ListingOfferV1",
    message,
    signature: listing.offer.signature,
  });
  if (signer.toLowerCase() !== message.offerSigner.toLowerCase()) {
    throw new Error("Bazaar listing offer signature does not match offerSigner");
  }
}
