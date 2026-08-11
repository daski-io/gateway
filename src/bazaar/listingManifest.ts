import { keccak256, toBytes } from "viem";
import { canonicalJsonStringify } from "../auth/envelope.js";
import { isHex32, isHexAddress } from "../util/evmValidation.js";
import { validateStockFixedDiscoverySchemas } from "./discoverySchemas.js";
import type { BazaarListing, ListingOfferV1 } from "./types.js";

const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_URL_LENGTH = 2_048;
const MAX_TERMS_DOCUMENT_BYTES = 128 * 1024;
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_REFERENCE_KEYS = new Set([
  "$dynamicRef",
  "$id",
  "$recursiveRef",
  "$ref",
]);
export const BASE_SEPOLIA_USDC =
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const LISTING_KEYS = [
  "assetName", "assetVersion", "description", "expectedDelivery",
  "listingCommitment", "listingEpoch", "offer", "policyVersion", "refundTerms",
  "payToControlProof", "requestSchema", "resourceUrl", "responseSchema", "routePath", "sellerName",
  "termsDocumentBase64", "termsDocumentHash", "termsDocumentMediaType",
  "termsHash", "termsUrl",
];
const OFFER_KEYS = ["message", "signature"];
const PAY_TO_PROOF_KEYS = ["signature", "validBefore"];
const MESSAGE_KEYS = [
  "chainId", "listingEpoch", "listingCommitment", "providerAgentId",
  "offerSigner", "providerPayee", "outcomeId", "methodHash", "resourceHash",
  "requestSchemaHash", "responseSchemaHash", "requestBindingModeHash",
  "routeModeHash", "token", "grossAmount", "payTo", "paymentMaxTimeoutSeconds",
  "daskiCommissionReceiver",
  "commissionBps", "splitterCodeHash", "termsHash", "policyVersion", "offerId",
  "issuedAt", "validBefore",
];

export function validateListingManifest(
  listing: BazaarListing,
  message: ListingOfferV1,
): void {
  if (
    !hasExactKeys(listing as unknown as Record<string, unknown>, LISTING_KEYS) ||
    !hasExactKeys(listing.offer as unknown as Record<string, unknown>, OFFER_KEYS) ||
    !hasExactKeys(
      listing.payToControlProof as unknown as Record<string, unknown>,
      PAY_TO_PROOF_KEYS,
    ) ||
    !hasExactKeys(message as unknown as Record<string, unknown>, MESSAGE_KEYS)
  ) throw new Error("Bazaar listing must use the closed manifest schema");
  validateUrlsAndMetadata(listing);
  validatePackagedTerms(listing);
  validateFixedFields(listing, message);
  validateHashes(listing, message);
}

function validateUrlsAndMetadata(listing: BazaarListing): void {
  if (
    listing.resourceUrl.length > MAX_URL_LENGTH ||
    listing.termsUrl.length > MAX_URL_LENGTH
  ) throw new Error("Bazaar listing URL exceeds the release limit");
  const resource = parseUrl(listing.resourceUrl, "Bazaar resource URL is invalid");
  if (
    resource.protocol !== "https:" || resource.username || resource.password ||
    resource.search || resource.hash || resource.pathname !== listing.routePath ||
    !/^\/x402\/v1\/outcomes\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(listing.routePath)
  ) throw new Error("Bazaar resource must be one fixed HTTPS outcome route");
  const terms = parseUrl(listing.termsUrl, "Bazaar listing terms URL is invalid");
  if (
    terms.protocol !== "https:" || terms.username || terms.password ||
    terms.search || terms.hash ||
    !/^\/terms\/v[1-9][0-9]*\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(terms.pathname)
  ) {
    throw new Error("Bazaar listing terms URL must use HTTPS");
  }
  if (
    !/^[\x20-\x7e]+$/.test(listing.sellerName) || listing.sellerName.length > 32 ||
    looksLikeInstructionOrSecret(listing.sellerName) ||
    !boundedText(listing.description, 500) ||
    !boundedText(listing.expectedDelivery, 500) ||
    !boundedText(listing.refundTerms, 1_000) ||
    !boundedText(listing.assetName, 64) ||
    !boundedText(listing.assetVersion, 32)
  ) throw new Error("Bazaar listing metadata is malformed or oversized");
  validateStaticDiscoveryObject(listing.requestSchema);
  validateStaticDiscoveryObject(listing.responseSchema);
  validateStockFixedDiscoverySchemas(listing);
}

function validateFixedFields(listing: BazaarListing, message: ListingOfferV1): void {
  const bytes32 = [
    message.listingEpoch, message.listingCommitment, message.outcomeId,
    message.methodHash, message.resourceHash, message.requestSchemaHash,
    message.responseSchemaHash, message.requestBindingModeHash,
    message.routeModeHash, message.splitterCodeHash, message.termsHash,
    message.policyVersion, message.offerId, listing.listingEpoch,
    listing.listingCommitment, listing.termsHash, listing.termsDocumentHash,
    listing.policyVersion,
  ];
  const addresses = [
    message.offerSigner, message.providerPayee, message.token, message.payTo,
    message.daskiCommissionReceiver,
  ];
  if (!bytes32.every(isHex32) || !addresses.every(isHexAddress)) {
    throw new Error("Bazaar listing contains malformed fixed-width fields");
  }
  const zeroAddress = `0x${"00".repeat(20)}`;
  if ([message.offerSigner, message.providerPayee, message.token, message.payTo]
    .some((address) => address.toLowerCase() === zeroAddress)) {
    throw new Error("Bazaar listing cannot use a zero financial address");
  }
  if (
    listing.listingEpoch.toLowerCase() !== message.listingEpoch.toLowerCase() ||
    listing.listingCommitment.toLowerCase() !== message.listingCommitment.toLowerCase() ||
    listing.termsHash.toLowerCase() !== message.termsHash.toLowerCase() ||
    listing.policyVersion.toLowerCase() !== message.policyVersion.toLowerCase() ||
    message.termsHash.toLowerCase() !== computeListingTermsHash(listing).toLowerCase() ||
    message.token.toLowerCase() !== BASE_SEPOLIA_USDC ||
    listing.assetName !== "USDC" || listing.assetVersion !== "2"
  ) throw new Error("Bazaar offer does not match its release manifest");
}

export function computeListingTermsHash(listing: Pick<
  BazaarListing,
  "description" | "expectedDelivery" | "refundTerms" | "sellerName" |
  "termsUrl" | "termsDocumentHash"
>): `0x${string}` {
  return keccak256(toBytes(canonicalJsonStringify({
    description: listing.description,
    expectedDelivery: listing.expectedDelivery,
    refundTerms: listing.refundTerms,
    sellerName: listing.sellerName,
    termsUrl: listing.termsUrl,
    termsDocumentHash: listing.termsDocumentHash.toLowerCase(),
  })));
}

function validatePackagedTerms(listing: BazaarListing): void {
  if (
    listing.termsDocumentMediaType !== "text/markdown; charset=utf-8" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      listing.termsDocumentBase64,
    )
  ) throw new Error("Bazaar packaged terms are malformed");
  const bytes = Buffer.from(listing.termsDocumentBase64, "base64");
  if (
    bytes.length === 0 || bytes.length > MAX_TERMS_DOCUMENT_BYTES ||
    bytes.toString("base64") !== listing.termsDocumentBase64 ||
    keccak256(bytes).toLowerCase() !== listing.termsDocumentHash.toLowerCase()
  ) throw new Error("Bazaar packaged terms do not match their signed hash");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Bazaar packaged terms are not valid UTF-8");
  }
  if (!safeNormalizedDocumentText(text)) {
    throw new Error("Bazaar packaged terms contain unsafe text");
  }
}

function validateHashes(listing: BazaarListing, message: ListingOfferV1): void {
  const requestJson = canonicalJsonStringify(listing.requestSchema);
  const responseJson = canonicalJsonStringify(listing.responseSchema);
  if (
    Buffer.byteLength(requestJson, "utf8") > MAX_SCHEMA_BYTES ||
    Buffer.byteLength(responseJson, "utf8") > MAX_SCHEMA_BYTES
  ) throw new Error("Bazaar listing schema exceeds the release limit");
  if (
    message.methodHash !== keccak256(toBytes("POST")) ||
    message.resourceHash !== keccak256(toBytes(listing.resourceUrl)) ||
    message.requestSchemaHash !== keccak256(toBytes(requestJson)) ||
    message.responseSchemaHash !== keccak256(toBytes(responseJson)) ||
    message.requestBindingModeHash !== keccak256(toBytes("stock-fixed-v1")) ||
    message.routeModeHash !== keccak256(toBytes("test-provider-direct-v1"))
  ) throw new Error("Bazaar listing hashes do not match its public artifacts");
}

function parseUrl(value: string, message: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(message);
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function boundedText(value: string, maximum: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    safeNormalizedText(value) && !looksLikeInstructionOrSecret(value);
}

function safeNormalizedText(value: string): boolean {
  return value.normalize("NFC") === value &&
    !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u
      .test(value);
}

function safeNormalizedDocumentText(value: string): boolean {
  return value.normalize("NFC") === value && !value.includes("\r") &&
    !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u
      .test(value);
}

function looksLikeInstructionOrSecret(value: string): boolean {
  return /(?:ignore (?:all |any )?(?:previous|prior)|system prompt|developer message|call (?:a )?tool|execute (?:this|code)|send (?:funds|money)|private key|api[_ -]?key|bearer [a-z0-9_.-]+|password\s*[:=]|secret\s*[:=]|<\/?[a-z][^>]*>)/iu
    .test(value);
}

function validateStaticDiscoveryObject(value: unknown, depth = 0): void {
  if (depth > 16) throw new Error("Bazaar discovery schema is too deeply nested");
  if (typeof value === "string") {
    if (!safeNormalizedText(value) || looksLikeInstructionOrSecret(value)) {
      throw new Error("Bazaar discovery schema contains unsafe static text");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateStaticDiscoveryObject(item, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!safeNormalizedText(key) || looksLikeInstructionOrSecret(key)) {
        throw new Error("Bazaar discovery schema contains an unsafe key");
      }
      if (SCHEMA_REFERENCE_KEYS.has(key)) {
        throw new Error("Bazaar discovery schema contains a forbidden reference");
      }
      if (key === "$schema" && item !== JSON_SCHEMA_DIALECT) {
        throw new Error("Bazaar discovery schema uses an unsupported dialect");
      }
      validateStaticDiscoveryObject(item, depth + 1);
    }
  }
}
