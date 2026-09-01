import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { paymentIdentifierSchema } from "@x402/extensions/payment-identifier";
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
import { assertNoDuplicateJsonKeys, canonicalHash, recipeNonce, recipeNonceV2 } from "./canonical.js";
import { standardRailError } from "./errors.js";
import type { StandardListing, StandardOrderRecord } from "./types.js";

export const EIP3009_TYPES = {
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

export function paymentAuthorizationRecipeInputs(args: {
  config: Config;
  listing: StandardListing;
  order: StandardOrderRecord;
  requirements: PaymentRequirements;
  payer: Address;
}) {
  return {
    chainId: args.config.chainId,
    canonicalToken: getAddress(args.requirements.asset),
    payer: getAddress(args.payer),
    splitter: getAddress(args.requirements.payTo),
    grossAmount: BigInt(args.requirements.amount),
    listingManifestHash: args.order.listingManifestHash,
    providerOfferHash: args.order.providerOfferHash,
    runtimeCommitmentHash: args.order.listingManifestHash,
    providerIntentHash: args.order.providerOfferHash,
    quoteHash: args.order.quoteHash,
    canonicalRequestHash: args.order.canonicalRequestHash,
    orderNonce: args.order.orderNonce,
  };
}

export function paymentAuthorizationNonce(args: {
  config: Config;
  listing: StandardListing;
  order: StandardOrderRecord;
  requirements: PaymentRequirements;
  payer: Address;
}): Hex {
  const inputs = paymentAuthorizationRecipeInputs(args);
  if (args.listing.commitment.payload.bindingProfile === "stock-fixed-v1") {
    return args.order.orderNonce;
  }
  return args.listing.commitment.payload.bindingProfile === "recipe-bound-v2"
    ? recipeNonceV2(inputs)
    : recipeNonce(inputs);
}

export function paymentAuthorizationMessage(args: {
  config: Config;
  listing: StandardListing;
  order: StandardOrderRecord;
  requirements: PaymentRequirements;
  payer: Address;
  validAfter: bigint;
  validBefore: bigint;
}) {
  return {
    from: getAddress(args.payer),
    to: getAddress(args.requirements.payTo),
    value: args.requirements.amount,
    validAfter: args.validAfter.toString(),
    validBefore: args.validBefore.toString(),
    nonce: paymentAuthorizationNonce(args),
  };
}

export function paymentRequired(args: {
  config: Config;
  requirements: PaymentRequirements;
  listing: StandardListing;
  order: StandardOrderRecord;
  railProfileHash: Hex;
  payerAddress?: Address;
  nowSeconds?: number;
}): PaymentRequired {
  const bindingProfile = args.listing.commitment.payload.bindingProfile;
  const expiresAt = Math.floor(args.order.expiresAt.getTime() / 1_000);
  const binding = bindingProfile === "recipe-bound-v2"
    ? {
        version: 2,
        profile: "recipe-bound-v2",
        runtimeCommitmentHash: args.order.listingManifestHash,
        providerIntentHash: args.order.providerOfferHash,
        quoteHash: args.order.quoteHash,
        canonicalRequestHash: args.order.canonicalRequestHash,
        orderNonce: args.order.orderNonce,
        expiresAt,
      }
    : bindingProfile === "recipe-bound-v1"
      ? {
          version: 1,
          profile: "recipe-bound-v1",
          listingManifestHash: args.order.listingManifestHash,
          providerOfferHash: args.order.providerOfferHash,
          quoteHash: args.order.quoteHash,
          canonicalRequestHash: args.order.canonicalRequestHash,
          orderNonce: args.order.orderNonce,
          expiresAt,
        }
      : undefined;
  const schemaHash = canonicalHash(args.listing.requestSchema);
  const extensions: Record<string, unknown> = {
    "payment-identifier": {
      info: { required: true, id: args.order.intentId },
      schema: paymentIdentifierSchema,
    },
    bazaar: {
      info: {
        schemaRef: {
          hash: schemaHash,
          url: `${args.config.publicUrl}/public/v2/artifacts/${schemaHash}`,
        },
        detailTool: "daski_get_outcome",
      },
    },
    ...(binding ? { "daski-order-binding": binding } : {}),
    "daski-rail-profile": { hash: args.railProfileHash },
    "daski-order-terms": {
      termsHash: canonicalHash(args.listing.terms),
      commissionBps: args.listing.commitment.payload.commissionBps,
    },
  };
  const challenge: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: args.listing.commitment.payload.absoluteResourceUri,
      description: `Daski outcome ${args.listing.commitment.payload.outcomeId}`,
      mimeType: "application/json",
      serviceName: args.listing.offer.payload.skillId,
    },
    accepts: [args.requirements],
    extensions,
  };
  if (!args.payerAddress) return challenge;
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const message = paymentAuthorizationMessage({
    config: args.config,
    listing: args.listing,
    order: args.order,
    requirements: args.requirements,
    payer: args.payerAddress,
    validAfter: BigInt(now - 5),
    validBefore: BigInt(Math.min(expiresAt, now + args.requirements.maxTimeoutSeconds)),
  });
  challenge.extensions = {
    ...extensions,
    "daski-sign-request": {
      version: 1,
      signaturePurpose: "daski-standard-purchase",
      expiresAt,
      eip712: {
        domain: {
          name: args.config.usdc.name,
          version: args.config.usdc.version,
          chainId: args.config.chainId,
          verifyingContract: getAddress(args.requirements.asset),
        },
        primaryType: "TransferWithAuthorization",
        types: EIP3009_TYPES,
        message,
      },
      submitAs: {
        how: "Sign eip712 with the payer key exactly as given. Retry the identical call with _meta[\"x402/payment\"] (preferred) or the paymentPayload argument set to the object below.",
        paymentPayload: {
          x402Version: 2,
          resource: challenge.resource,
          accepted: args.requirements,
          payload: {
            signature: "<0x…65-byte hex from signing>",
            authorization: message,
          },
          extensions,
        },
      },
    },
  };
  return challenge;
}

export function assertPaymentIdentifierExtension(value: unknown, issued: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !issued || typeof issued !== "object" || Array.isArray(issued)) {
    throw standardRailError("EXTENSION_MISMATCH", {
      field: "payment-identifier",
      message: "The payment identifier extension is malformed",
    });
  }
  if (canonicalHash(value) !== canonicalHash(issued)) {
    throw standardRailError("EXTENSION_MISMATCH", {
      field: "payment-identifier",
      message: "The payment identifier differs from the issued challenge",
    });
  }
}

// Node buyers (undici) refuse any response whose combined header block
// exceeds 16 KiB, so the mirrored PAYMENT-REQUIRED header owns an 8 KiB
// budget. The 402 JSON body always carries the complete challenge.
export const PAYMENT_REQUIRED_HEADER_BUDGET = 8_192;

export function encodedPaymentRequiredHeader(challenge: PaymentRequired): string | null {
  const complete = encodeHeader(challenge);
  if (complete.length <= PAYMENT_REQUIRED_HEADER_BUDGET) return complete;
  const { bazaar: _discovery, ...extensions } = challenge.extensions ?? {};
  const compact = encodeHeader({ ...challenge, extensions });
  return compact.length <= PAYMENT_REQUIRED_HEADER_BUDGET ? compact : null;
}

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodePaymentHeader(header: string): PaymentPayload {
  if (header.length > 24_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(header)) {
    throw standardRailError("PAYLOAD_SHAPE_INVALID", {
      field: "PAYMENT-SIGNATURE",
      message: "PAYMENT-SIGNATURE is malformed",
    });
  }
  try {
    const text = Buffer.from(header, "base64url").toString("utf8");
    assertNoDuplicateJsonKeys(text);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as PaymentPayload;
  } catch (error) {
    throw standardRailError("PAYLOAD_SHAPE_INVALID", {
      field: "PAYMENT-SIGNATURE",
      message: "PAYMENT-SIGNATURE is not valid base64url JSON",
      cause: error,
    });
  }
}

export function normalizePaymentPayload(payment: PaymentPayload): PaymentPayload {
  const extensions = { ...(payment.extensions ?? {}) };
  delete extensions["daski-sign-request"];
  return { ...payment, extensions };
}

export function paymentIntentId(payment: PaymentPayload): string {
  const extension = payment.extensions?.["payment-identifier"];
  const info = extension && typeof extension === "object" && !Array.isArray(extension)
    ? (extension as Record<string, unknown>).info
    : undefined;
  const id = info && typeof info === "object" && !Array.isArray(info)
    ? (info as Record<string, unknown>).id
    : undefined;
  if (typeof id !== "string" || id.length < 16 || id.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw standardRailError("EXTENSION_REQUIRED_MISSING", {
      field: "payment-identifier",
      message: "A valid payment identifier is required",
    });
  }
  return id;
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
  ) throw standardRailError("AUTHORIZATION_SHAPE_INVALID", {
    field: "payload.authorization",
    message: "Payment authorization identity is malformed",
  });
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
  validAfterBackstopSeconds?: number;
  nowSeconds?: number;
}): Promise<ValidatedAuthorization> {
  const { config, listing, order, requirements } = args;
  const payment = normalizePaymentPayload(args.payment);
  const paymentKeys = ["x402Version", "resource", "accepted", "payload", "extensions"].sort();
  if (Object.keys(payment as unknown as Record<string, unknown>).sort().join(",") !==
      paymentKeys.join(",")) {
    throw standardRailError("PAYLOAD_SHAPE_INVALID", {
      message: "Payment payload has an open shape",
    });
  }
  const issued = paymentRequired({
    config,
    requirements,
    listing,
    order,
    railProfileHash: args.railProfileHash,
  });
  if (canonicalHash(payment.resource) !== canonicalHash(issued.resource)) {
    throw standardRailError("AUTHORIZATION_MISMATCH", {
      field: "resource",
      message: "Payment resource differs from the issued challenge",
    });
  }
  if (canonicalHash(payment.accepted) !== canonicalHash(requirements)) {
    throw standardRailError("AUTHORIZATION_MISMATCH", {
      field: "accepted",
      message: "Payment requirements differ from the issued challenge",
    });
  }
  if (payment.x402Version !== 2) {
    throw standardRailError("PAYMENT_VERSION_UNSUPPORTED", {
      field: "x402Version",
    });
  }
  const allowedExtensions = new Set([
    ...listing.extensionPolicy.requiredExtensions,
    ...listing.extensionPolicy.optionalExtensions,
    "payment-identifier",
    "daski-sign-request",
  ]);
  for (const key of Object.keys(args.payment.extensions ?? {})) {
    if (!allowedExtensions.has(key)) {
      throw standardRailError("EXTENSION_MISMATCH", {
        field: key,
        message: `Unsupported payment extension: ${key}`,
      });
    }
  }
  const issuedExtensions = issued.extensions ?? {};
  const requiredExtensions = new Set([
    ...listing.extensionPolicy.requiredExtensions,
    "payment-identifier",
  ]);
  for (const key of requiredExtensions) {
    if (payment.extensions?.[key] === undefined) {
      throw standardRailError("EXTENSION_REQUIRED_MISSING", {
        field: key,
        message: `Payment extension ${key} is required`,
      });
    }
  }
  for (const [key, value] of Object.entries(payment.extensions ?? {})) {
    if (key === "payment-identifier") {
      assertPaymentIdentifierExtension(value, issuedExtensions[key]);
      continue;
    }
    if (issuedExtensions[key] === undefined ||
        canonicalHash(value) !== canonicalHash(issuedExtensions[key])) {
      throw standardRailError("EXTENSION_MISMATCH", {
        field: key,
        message: `Payment extension ${key} differs from the issued challenge`,
      });
    }
  }
  paymentIntentId(payment);

  const payload = payment.payload as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !["signature", "authorization"].includes(key))) {
    throw standardRailError("PAYLOAD_SHAPE_INVALID");
  }
  const signature = payload.signature;
  const authorization = payload.authorization as Record<string, unknown> | undefined;
  if (typeof signature !== "string" || !authorization ||
      typeof authorization !== "object" || Array.isArray(authorization)) {
    throw standardRailError("PAYLOAD_SHAPE_INVALID", {
      field: "payload.authorization",
      message: "Missing EIP-3009 authorization",
    });
  }
  const expectedKeys = ["from", "to", "value", "validAfter", "validBefore", "nonce"].sort();
  if (Object.keys(authorization).sort().join(",") !== expectedKeys.join(",")) {
    throw standardRailError("AUTHORIZATION_SHAPE_INVALID", {
      field: "payload.authorization",
    });
  }

  let payer: Address;
  let nonce: Hex;
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    payer = getAddress(String(authorization.from));
    nonce = String(authorization.nonce) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("invalid nonce");
    validAfter = BigInt(String(authorization.validAfter));
    validBefore = BigInt(String(authorization.validBefore));
  } catch (error) {
    throw standardRailError("AUTHORIZATION_SHAPE_INVALID", {
      field: "payload.authorization",
      cause: error,
    });
  }
  const nowNumber = args.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const now = BigInt(nowNumber);
  const expires = BigInt(Math.floor(order.expiresAt.getTime() / 1_000));
  let to: Address;
  try {
    to = getAddress(String(authorization.to));
  } catch (error) {
    throw standardRailError("AUTHORIZATION_SHAPE_INVALID", {
      field: "payload.authorization.to",
      cause: error,
    });
  }
  if (to !== getAddress(requirements.payTo)) {
    throw standardRailError("AUTHORIZATION_MISMATCH", {
      field: "payload.authorization.to",
      expected: { to: getAddress(requirements.payTo) },
    });
  }
  if (String(authorization.value) !== requirements.amount) {
    throw standardRailError("AUTHORIZATION_MISMATCH", {
      field: "payload.authorization.value",
      expected: { value: requirements.amount },
    });
  }
  if (validBefore <= now + 10n || validBefore > expires) {
    throw standardRailError("AUTHORIZATION_MISMATCH", {
      field: "payload.authorization.validBefore",
      serverTime: nowNumber,
      expected: {
        validBefore: {
          minExclusive: (now + 10n).toString(),
          max: expires.toString(),
        },
      },
    });
  }
  const backstopSeconds = args.validAfterBackstopSeconds ?? 3_600;
  const backstop = BigInt(backstopSeconds);
  if (validAfter !== 0n && (validAfter < now - backstop || validAfter > now)) {
    throw standardRailError("AUTHORIZATION_WINDOW", {
      field: "payload.authorization.validAfter",
      message: `validAfter must be 0 or within ${backstopSeconds} seconds before server time`,
      serverTime: nowNumber,
      expected: {
        validAfter: {
          oneOf: [
            "0",
            { min: nowNumber - backstopSeconds, max: nowNumber },
          ],
        },
      },
    });
  }

  const forbidden = [
    listing.manifest.payload.splitterAddress,
    listing.commitment.payload.providerPayee,
    listing.commitment.payload.daskiCommissionReceiver,
    listing.commitment.payload.providerAuthorityKey,
    listing.commitment.payload.providerTerminalAttestationKey,
    ...listing.screeningPolicy.providerControlledWallets,
  ].map(getAddress);
  if (forbidden.includes(payer)) {
    throw standardRailError("SELF_PURCHASE_FORBIDDEN", { field: "payload.authorization.from" });
  }

  const expectedNonce = paymentAuthorizationNonce({
    config,
    listing,
    order,
    requirements,
    payer,
  });
  if (nonce.toLowerCase() !== expectedNonce.toLowerCase()) {
    const inputs = paymentAuthorizationRecipeInputs({
      config,
      listing,
      order,
      requirements,
      payer,
    });
    throw standardRailError("NONCE_RECIPE_MISMATCH", {
      field: "payload.authorization.nonce",
      expected: {
        recipeInputs: {
          chainId: inputs.chainId,
          canonicalToken: inputs.canonicalToken,
          payer: inputs.payer,
          splitter: inputs.splitter,
          grossAmount: inputs.grossAmount.toString(),
          listingManifestHash: inputs.listingManifestHash,
          providerOfferHash: inputs.providerOfferHash,
          runtimeCommitmentHash: inputs.runtimeCommitmentHash,
          providerIntentHash: inputs.providerIntentHash,
          quoteHash: inputs.quoteHash,
          canonicalRequestHash: inputs.canonicalRequestHash,
          orderNonce: inputs.orderNonce,
        },
      },
    });
  }

  let parsedSignature;
  try {
    parsedSignature = parseSignature(signature as Hex);
  } catch (error) {
    throw standardRailError("SIGNATURE_INVALID", {
      field: "payload.signature",
      cause: error,
    });
  }
  if (BigInt(parsedSignature.s) > HALF_CURVE_ORDER) {
    throw standardRailError("SIGNATURE_INVALID", {
      field: "payload.signature",
      message: "High-s signatures are forbidden",
    });
  }
  let valid = false;
  try {
    valid = await verifyTypedData({
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
  } catch (error) {
    throw standardRailError("SIGNATURE_INVALID", {
      field: "payload.signature",
      cause: error,
    });
  }
  if (!valid) {
    throw standardRailError("SIGNATURE_INVALID", { field: "payload.signature" });
  }
  return {
    payer,
    nonce,
    authorizationKey: paymentAuthorizationLookupKey(config, payment),
  };
}
