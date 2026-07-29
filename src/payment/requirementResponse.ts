import { keccak256, toBytes } from "viem";
import { canonicalJsonStringify } from "../auth/envelope.js";
import type { Config } from "../config.js";
import type { PurchaseLegalContext } from "../legal/types.js";
import type {
  DaskiMarketplaceExtension,
  Hex,
  PaymentRequired,
  PaymentRequirements,
  StoredChallenge,
} from "../types.js";
import { buildDaskiX402Declaration } from "./x402Extension.js";
import { purchaseDescription } from "./skillOffer.js";

interface RequirementResponseInput {
  config: Config;
  providerTokenId: bigint;
  buyerTokenId: bigint;
  skillId: string;
  resource: string;
  walletAddress: Hex;
  amount: bigint;
  serviceSlug: string;
  serviceVersion: string;
  serviceId: Hex;
  serviceRef: Hex;
  providerA2AUrl: string;
  agentCard: Record<string, unknown>;
  marketplaceExtension: DaskiMarketplaceExtension;
  quote: {
    quoteId: string;
    providerSignature: Hex;
    expiresAt: Date;
    requestHash: Hex;
  };
  purchaseLegal: PurchaseLegalContext;
  effectiveExpiresAt: Date;
  requestFingerprint: Hex;
  serviceArgs: Record<string, unknown>;
  warnings: string[];
  registrationDelegation?: StoredChallenge["registrationDelegation"];
  existingChallenge: StoredChallenge | null;
  now: Date;
}

export interface RequirementResponse {
  requirements: PaymentRequirements;
  paymentRequired: PaymentRequired;
  purchaseLegal: PurchaseLegalContext;
  challenge: StoredChallenge;
}

export function buildRequirementResponse(
  input: RequirementResponseInput,
): RequirementResponse {
  if (input.existingChallenge?.paymentRequired) {
    const requirements = input.existingChallenge.paymentRequired.accepts[0];
    if (!requirements) {
      throw new Error("stored V2 challenge has no accepted payment method");
    }
    return {
      requirements,
      paymentRequired: input.existingChallenge.paymentRequired,
      purchaseLegal: input.purchaseLegal,
      challenge: input.existingChallenge,
    };
  }

  const description = purchaseDescription(
    input.providerTokenId,
    input.agentCard,
    input.marketplaceExtension,
    input.skillId,
  );
  const requirements: PaymentRequirements = {
    scheme: "daski-exact",
    network: input.config.x402Network,
    amount: input.amount.toString(),
    asset: input.config.usdcAddress,
    payTo: input.config.x402AdapterAddress,
    maxTimeoutSeconds: Math.max(
      1,
      Math.floor(
        (input.effectiveExpiresAt.getTime() - input.now.getTime()) / 1000,
      ),
    ),
    extra: {
      assetTransferMethod: "eip3009-receive",
      name: input.config.usdcName,
      version: input.config.usdcVersion,
      daskiProfile: "1",
      authorizationValidBefore: Math.floor(
        input.effectiveExpiresAt.getTime() / 1000,
      ).toString(),
      paymentRouter: input.config.paymentRouterAddress,
      providerAgentId: input.providerTokenId.toString(),
      serviceId: input.serviceId,
      serviceRef: input.serviceRef,
    },
  };
  const daskiExtension = buildDaskiX402Declaration(input.config.publicUrl, {
    profile: "1",
    x402Adapter: input.config.x402AdapterAddress,
    paymentRouter: input.config.paymentRouterAddress,
    serviceRef: input.serviceRef,
    providerAgentId: input.providerTokenId.toString(),
    buyerAgentId: input.buyerTokenId.toString(),
    serviceId: input.serviceId,
    skillId: input.skillId,
    serviceSlug: input.serviceSlug,
    serviceVersion: input.serviceVersion,
    providerA2AUrl: input.providerA2AUrl,
    quote: {
      id: input.quote.quoteId,
      signature: input.quote.providerSignature,
      expiresAt: input.quote.expiresAt.toISOString(),
    },
    settlementMode:
      input.buyerTokenId === 0n ? "register-and-settle" : "settle-only",
    ...(input.warnings.length > 0 ? { warnings: input.warnings } : {}),
  });
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: input.resource,
      description,
      mimeType: "application/json",
      serviceName: "Daski",
      tags: ["agent-marketplace", "a2a"],
    },
    accepts: [requirements],
    extensions: {
      "https://daski.xyz/x402/v2": daskiExtension,
    },
  };
  const requirementsHash = hashCanonical(requirements);

  const challenge: StoredChallenge = {
    serviceRef: input.serviceRef,
    providerTokenId: input.providerTokenId,
    buyerTokenId: input.buyerTokenId,
    skillId: input.skillId,
    serviceSlug: input.serviceSlug,
    serviceVersion: input.serviceVersion,
    serviceId: input.serviceId,
    amount: input.amount,
    providerA2AUrl: input.providerA2AUrl,
    walletAddress: input.walletAddress.toLowerCase() as Hex,
    createdAt: input.now,
    expiresAt: input.effectiveExpiresAt,
    settlementState: "pending",
    paymentId: null,
    transactionHash: null,
    preparedTransaction: null,
    preparedTransactionNonce: null,
    preparedAt: null,
    verifiedAt: null,
    confirmationAttestationUid: null,
    quoteId: input.quote.quoteId,
    quoteSignature: input.quote.providerSignature,
    quoteExpiresAt: input.quote.expiresAt,
    quoteRequestHash: input.quote.requestHash,
    serviceArgs: input.serviceArgs,
    x402Version: 2,
    paymentRequired,
    requirementsHash,
    resourceUrl: input.resource,
    daskiExtension,
    requestFingerprint: input.requestFingerprint,
    registrationDelegation: input.registrationDelegation ?? null,
    acceptedPayer: null,
    eip3009Nonce: null,
    paymentPayloadFingerprint: null,
    settleResponse: null,
  };

  return {
    requirements,
    paymentRequired,
    purchaseLegal: input.purchaseLegal,
    challenge,
  };
}

export function hashCanonical(value: unknown): Hex {
  return keccak256(toBytes(canonicalJsonStringify(value)));
}
