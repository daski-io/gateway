import { encodeAbiParameters, keccak256 } from "viem";
import type { Config } from "../config.js";
import type { PurchaseLegalContext } from "../legal/types.js";
import type {
  DaskiMarketplaceExtension,
  DaskiRail,
  Eip712TypedData,
  Hex,
  PaymentRequirements,
  StoredChallenge,
} from "../types.js";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "./protocol.js";
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
  existingChallenge: StoredChallenge | null;
  now: Date;
}

function buildRails(config: Config): DaskiRail[] {
  const rails: DaskiRail[] = [
    { name: "x402", kind: "eip3009", adapter: config.x402AdapterAddress },
  ];
  if (config.permitAdapterAddress) {
    rails.push({
      name: "permit",
      kind: "eip2612",
      adapter: config.permitAdapterAddress,
    });
  }
  if (config.approvalAdapterAddress) {
    rails.push({
      name: "approval",
      kind: "erc20-approve",
      adapter: config.approvalAdapterAddress,
    });
  }
  return rails;
}

function buildTypedData(input: RequirementResponseInput): Eip712TypedData {
  const nonce = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
      [input.serviceRef, input.providerTokenId, input.serviceId],
    ),
  ) as Hex;

  return {
    domain: {
      name: input.config.usdcName,
      version: input.config.usdcVersion,
      chainId: input.config.chainId,
      verifyingContract: input.config.usdcAddress,
    },
    types: {
      TransferWithAuthorization:
        TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization.map((f) => ({
          name: f.name,
          type: f.type,
        })),
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: input.walletAddress,
      to: input.config.paymentRouterAddress,
      value: input.amount.toString(),
      validAfter: "0",
      validBefore: BigInt(
        Math.floor(input.effectiveExpiresAt.getTime() / 1000),
      ).toString(),
      nonce,
    },
  };
}

export function buildRequirementResponse(input: RequirementResponseInput): {
  requirements: PaymentRequirements;
  challenge: StoredChallenge;
} {
  const eip712TypedData = buildTypedData(input);
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: input.config.network,
    chainId: `eip155:${input.config.chainId}`,
    maxAmountRequired: input.amount.toString(),
    resource: input.resource,
    description: purchaseDescription(
      input.providerTokenId,
      input.agentCard,
      input.marketplaceExtension,
      input.skillId,
    ),
    mimeType: "application/json",
    payTo: input.config.paymentRouterAddress,
    maxTimeoutSeconds: Math.max(
      1,
      Math.floor(
        (input.effectiveExpiresAt.getTime() - input.now.getTime()) / 1000,
      ),
    ),
    asset: input.config.usdcAddress,
    outputSchema: null,
    extra: {
      name: input.config.usdcName,
      version: input.config.usdcVersion,
      daski: {
        providerTokenId: input.providerTokenId.toString(),
        buyerTokenId: input.buyerTokenId.toString(),
        skillId: input.skillId,
        serviceSlug: input.serviceSlug,
        serviceVersion: input.serviceVersion,
        serviceId: input.serviceId,
        serviceRef: input.serviceRef,
        token: input.config.usdcAddress,
        rails: buildRails(input.config),
        acceptedTokens: [input.config.usdcAddress],
        eip712TypedData,
        settlementMode:
          input.buyerTokenId === 0n ? "atomic-register" : "settle-only",
        quote: {
          quoteId: input.quote.quoteId,
          quoteSignature: input.quote.providerSignature,
          expiresAt: input.quote.expiresAt.toISOString(),
        },
        ...input.purchaseLegal,
      },
    },
  };

  const challenge: StoredChallenge = input.existingChallenge ?? {
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
    verifiedAt: null,
    confirmationAttestationUid: null,
    quoteId: input.quote.quoteId,
    quoteSignature: input.quote.providerSignature,
    quoteExpiresAt: input.quote.expiresAt,
    quoteRequestHash: input.quote.requestHash,
    serviceArgs: null,
    acknowledgements: {},
  };

  return { requirements, challenge };
}
