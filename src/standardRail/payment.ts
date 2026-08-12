import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { declarePaymentIdentifierExtension } from "@x402/extensions/payment-identifier";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseSignature,
  verifyTypedData,
  type Address,
} from "viem";
import type { Config } from "../config.js";
import type { Hex } from "../types.js";
import { assertNoDuplicateJsonKeys, canonicalHash, recipeNonce } from "./canonical.js";
import type { StandardListing, StandardOrderRecord } from "./types.js";

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const HALF_CURVE_ORDER = BigInt(
  "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0",
);

export function paymentRequirements(
  config: Config,
  listing: StandardListing,
  grossAmount: string,
  maxTimeoutSeconds: number,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.x402Network,
    asset: listing.commitment.payload.canonicalToken,
    amount: grossAmount,
    payTo: listing.manifest.payload.splitterAddress,
    maxTimeoutSeconds,
    extra: {
      assetTransferMethod: "eip3009",
      name: config.usdc.name,
      version: config.usdc.version,
    },
  };
}

export function paymentRequired(args: {
  requirements: PaymentRequirements;
  listing: StandardListing;
  order: StandardOrderRecord;
  railProfileHash: Hex;
}): PaymentRequired {
  const binding = args.listing.commitment.payload.bindingProfile === "recipe-bound-v1"
    ? {
        version: 1,
        profile: "recipe-bound-v1",
        listingManifestHash: args.order.listingManifestHash,
        providerOfferHash: args.order.providerOfferHash,
        quoteHash: args.order.quoteHash,
        canonicalRequestHash: args.order.canonicalRequestHash,
        orderNonce: args.order.orderNonce,
        expiresAt: Math.floor(args.order.expiresAt.getTime() / 1_000),
      }
    : undefined;
  return {
    x402Version: 2,
    resource: {
      url: args.listing.commitment.payload.absoluteResourceUri,
      description: args.listing.description,
      mimeType: "application/json",
      serviceName: args.listing.title,
    },
    accepts: [args.requirements],
    extensions: {
      "payment-identifier": declarePaymentIdentifierExtension(false),
      bazaar: {
        info: {
          input: args.listing.requestSchema,
          output: args.listing.responseSchema,
          seller: args.listing.terms.providerLegalName,
          marketplace: "Daski",
          marketplaceRole: "marketplace-and-transaction-infrastructure",
          payToRole: "immutable-outcome-splitter",
          payTo: args.listing.manifest.payload.splitterAddress,
          providerAgentId: args.listing.commitment.payload.providerAgentId,
          outcomeId: args.listing.commitment.payload.outcomeId,
        },
      },
      ...(binding ? { "daski-order-binding": binding } : {}),
      "daski-rail-profile": { hash: args.railProfileHash },
      "daski-order-terms": {
        listingManifestHash: args.order.listingManifestHash,
        providerOfferHash: args.order.providerOfferHash,
        quoteHash: args.order.quoteHash,
        canonicalRequestHash: args.order.canonicalRequestHash,
        orderNonce: args.order.orderNonce,
        providerLegalName: args.listing.terms.providerLegalName,
        marketplaceTermsUrl: args.listing.terms.marketplaceTermsUrl,
        marketplacePrivacyUrl: args.listing.terms.marketplacePrivacyUrl,
        providerTermsUrl: args.listing.terms.providerTermsUrl,
        providerPrivacyUrl: args.listing.terms.providerPrivacyUrl,
        commissionBps: args.listing.commitment.payload.commissionBps,
        refundPolicy: args.listing.refundPolicy,
        purchaseRetryPolicy: args.listing.commitment.payload.bindingProfile === "stock-fixed-v1"
          ? {
              identicalSignedAuthorization: "transport-retry-same-purchase",
              newlySignedAuthorization: "distinct-purchase-subject-to-advertised-refund-policy",
            }
          : {
              identicalSignedAuthorization: "transport-retry-same-purchase",
              newlySignedAuthorization: "must-bind-a-distinct-recipe-order",
            },
      },
    },
  };
}

export function assertPaymentIdentifierExtension(value: unknown, issued: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !issued || typeof issued !== "object" || Array.isArray(issued)) {
    throw new Error("Payment identifier extension is malformed");
  }
  const extension = value as Record<string, unknown>;
  const issuedExtension = issued as Record<string, unknown>;
  const keys = Object.keys(extension).sort();
  if (keys.join(",") !== "info,schema") {
    throw new Error("Payment identifier extension has an open shape");
  }
  const info = extension.info;
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    throw new Error("Payment identifier extension info is malformed");
  }
  const fields = Object.keys(info).sort();
  if (fields.some((key) => key !== "id" && key !== "required") ||
      !fields.includes("required") || (info as Record<string, unknown>).required !== false) {
    throw new Error("Payment identifier extension info has an open shape");
  }
  const id = (info as Record<string, unknown>).id;
  if (id !== undefined && (
    typeof id !== "string" || id.length < 16 || id.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(id)
  )) throw new Error("Payment identifier is invalid");
  const normalized = { ...extension, info: { required: false } };
  if (canonicalHash(normalized) !== canonicalHash(issuedExtension)) {
    throw new Error("Payment identifier declaration differs from the issued challenge");
  }
}

export function decodePaymentHeader(header: string): PaymentPayload {
  if (header.length > 24_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(header)) {
    throw new Error("PAYMENT-SIGNATURE is malformed");
  }
  let parsed: unknown;
  try {
    const text = Buffer.from(header, "base64url").toString("utf8");
    assertNoDuplicateJsonKeys(text);
    parsed = JSON.parse(text);
  } catch {
    throw new Error("PAYMENT-SIGNATURE is not valid base64url JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid payment payload");
  return parsed as PaymentPayload;
}

export interface ValidatedAuthorization {
  payer: Address;
  nonce: Hex;
  authorizationKey: Hex;
}

export function paymentAuthorizationLookupKey(config: Config, payment: PaymentPayload): Hex {
  const accepted = payment.accepted as unknown as Record<string, unknown> | undefined;
  const payload = payment.payload as Record<string, unknown> | undefined;
  const authorization = payload?.authorization as Record<string, unknown> | undefined;
  if (
    !accepted || !authorization || typeof accepted.asset !== "string" ||
    typeof authorization.from !== "string" || typeof authorization.nonce !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(accepted.asset) ||
    !/^0x[0-9a-fA-F]{40}$/.test(authorization.from) ||
    !/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)
  ) throw new Error("Payment authorization identity is malformed");
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
    [
      BigInt(config.chainId),
      getAddress(accepted.asset),
      getAddress(authorization.from),
      authorization.nonce as Hex,
    ],
  ));
}

export async function validatePayment(args: {
  config: Config;
  listing: StandardListing;
  order: StandardOrderRecord;
  requirements: PaymentRequirements;
  payment: PaymentPayload;
  railProfileHash: Hex;
  nowSeconds?: number;
}): Promise<ValidatedAuthorization> {
  const { config, listing, order, requirements, payment } = args;
  const paymentKeys = ["x402Version", "resource", "accepted", "payload", "extensions"];
  if (Object.keys(payment as unknown as Record<string, unknown>).sort().join(",") !== paymentKeys.sort().join(",")) {
    throw new Error("Payment payload has an open shape");
  }
  const issued = paymentRequired({
    requirements,
    listing,
    order,
    railProfileHash: args.railProfileHash,
  });
  if (canonicalHash(payment.resource) !== canonicalHash(issued.resource)) {
    throw new Error("Payment resource differs from the issued challenge");
  }
  if (canonicalHash(payment.accepted) !== canonicalHash(requirements)) {
    throw new Error("Payment requirements differ from the issued challenge");
  }
  const allowedExtensions = new Set([
    ...listing.extensionPolicy.requiredExtensions,
    ...listing.extensionPolicy.optionalExtensions,
  ]);
  if (payment.x402Version !== 2 || Object.keys(payment.extensions ?? {}).some(
    (key) => !allowedExtensions.has(key),
  )) {
    throw new Error("Unsupported payment version or extension");
  }
  const issuedExtensions = issued.extensions ?? {};
  for (const [key, value] of Object.entries(payment.extensions ?? {})) {
    if (key === "payment-identifier") {
      assertPaymentIdentifierExtension(value, issuedExtensions[key]);
      continue;
    }
    if (
      issuedExtensions[key] === undefined ||
      canonicalHash(value) !== canonicalHash(issuedExtensions[key])
    ) throw new Error(`Payment extension ${key} differs from the issued challenge`);
  }
  for (const key of listing.extensionPolicy.requiredExtensions) {
    if (payment.extensions?.[key] === undefined) {
      throw new Error(`Payment extension ${key} is required`);
    }
  }
  const payload = payment.payload as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !["signature", "authorization"].includes(key))) {
    throw new Error("Unsupported Exact-EVM payload field");
  }
  const signature = payload.signature;
  const authorization = payload.authorization as Record<string, unknown> | undefined;
  if (typeof signature !== "string" || !authorization) throw new Error("Missing EIP-3009 authorization");
  const expectedKeys = ["from", "to", "value", "validAfter", "validBefore", "nonce"];
  if (Object.keys(authorization).sort().join(",") !== expectedKeys.sort().join(",")) {
    throw new Error("EIP-3009 authorization has an open shape");
  }
  const payer = getAddress(String(authorization.from));
  const nonce = String(authorization.nonce) as Hex;
  const validAfter = BigInt(String(authorization.validAfter));
  const validBefore = BigInt(String(authorization.validBefore));
  const now = BigInt(args.nowSeconds ?? Math.floor(Date.now() / 1_000));
  const expires = BigInt(Math.floor(order.expiresAt.getTime() / 1_000));
  if (
    getAddress(String(authorization.to)) !== getAddress(requirements.payTo) ||
    String(authorization.value) !== requirements.amount ||
    validBefore <= now + 10n || validBefore > expires
  ) {
    throw new Error("EIP-3009 authorization does not match the challenge");
  }
  const forbidden = [
    listing.manifest.payload.splitterAddress,
    listing.commitment.payload.providerPayee,
    listing.commitment.payload.daskiCommissionReceiver,
    listing.commitment.payload.providerAuthorityKey,
    listing.commitment.payload.providerTerminalAttestationKey,
    listing.refundPolicy.executionReserveAddress,
    ...listing.screeningPolicy.providerControlledWallets,
  ].map(getAddress);
  if (forbidden.includes(payer)) throw new Error("Known self-purchase is forbidden");
  if (listing.commitment.payload.bindingProfile === "stock-fixed-v1") {
    if (validAfter !== 0n) throw new Error("Stock profile requires validAfter=0");
  } else {
    if (validAfter > now || validAfter + 300n < now) {
      throw new Error("Recipe authorization lower bound is outside the allowed clock window");
    }
    const expected = recipeNonce({
      chainId: config.chainId,
      canonicalToken: getAddress(requirements.asset),
      payer,
      splitter: getAddress(requirements.payTo),
      grossAmount: BigInt(requirements.amount),
      listingManifestHash: order.listingManifestHash,
      providerOfferHash: order.providerOfferHash,
      quoteHash: order.quoteHash,
      canonicalRequestHash: order.canonicalRequestHash,
      orderNonce: order.orderNonce,
    });
    if (nonce.toLowerCase() !== expected.toLowerCase()) throw new Error("Recipe nonce mismatch");
  }
  const parsedSignature = parseSignature(signature as Hex);
  if (BigInt(parsedSignature.s) > HALF_CURVE_ORDER) throw new Error("High-s signatures are forbidden");
  const valid = await verifyTypedData({
    address: payer,
    domain: {
      name: config.usdc.name,
      version: config.usdc.version,
      chainId: config.chainId,
      verifyingContract: getAddress(requirements.asset),
    },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: payer,
      to: getAddress(requirements.payTo),
      value: BigInt(requirements.amount),
      validAfter,
      validBefore,
      nonce,
    },
    signature: signature as Hex,
  });
  if (!valid) throw new Error("EIP-3009 signature is invalid");
  const authorizationKey = paymentAuthorizationLookupKey(config, payment);
  return { payer, nonce, authorizationKey };
}
