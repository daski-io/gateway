import { DASKI_X402_EXTENSION_URI } from "../config.js";
import type {
  DaskiX402Declaration,
  DaskiX402Info,
  DaskiX402Receipt,
  DaskiX402Signing,
  PaymentPayload,
  PaymentRequired,
  SettlementResponse,
} from "../types.js";
import { isHex32, isHexAddress } from "../util/evmValidation.js";

export const DASKI_X402_SCHEMA_PATH = "/.well-known/x402-daski-v2.schema.json";

function daskiX402SchemaRef(publicUrl: string): Record<string, unknown> {
  return { $ref: `${publicUrl}${DASKI_X402_SCHEMA_PATH}` };
}

export function daskiX402Schema(publicUrl: string): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${publicUrl}${DASKI_X402_SCHEMA_PATH}`,
    title: "Daski x402 V2 extension",
    oneOf: [
      {
        type: "object",
        required: ["info", "schema"],
        properties: {
          info: declarationInfoSchema(),
          schema: { type: "object" },
          signing: signingSchema(),
        },
        additionalProperties: true,
      },
      {
        type: "object",
        required: [
          "paymentId",
          "serviceRef",
          "providerAgentId",
          "buyerAgentId",
          "serviceId",
          "skillId",
          "providerA2AUrl",
          "registered",
          "quoteId",
          "quoteSignature",
        ],
        properties: {
          paymentId: { type: "string", pattern: "^[0-9]+$" },
          serviceRef: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
          providerAgentId: { type: "string", pattern: "^[0-9]+$" },
          buyerAgentId: { type: "string", pattern: "^[0-9]+$" },
          serviceId: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
          skillId: { type: "string" },
          providerA2AUrl: { type: "string", format: "uri" },
          registered: { type: "boolean" },
          quoteId: { type: "string" },
          quoteSignature: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["screening"],
        properties: {
          screening: {
            type: "object",
            required: ["code", "retryable"],
            properties: {
              code: {
                enum: [
                  "SANCTIONS_ADDRESS_REJECTED",
                  "SANCTIONS_SCREENING_UNAVAILABLE",
                ],
              },
              retryable: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    ],
  };
}

function signingSchema(): Record<string, unknown> {
  const address = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
  const bytes32 = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
  const decimal = { type: "string", pattern: "^[0-9]+$" };
  return {
    type: "object",
    required: [
      "eip712TypedData",
      "nonceSalt",
      "nonceDerivation",
      "nextAction",
    ],
    properties: {
      eip712TypedData: {
        type: "object",
        required: ["domain", "types", "primaryType", "message"],
        properties: {
          domain: { type: "object" },
          types: { type: "object" },
          primaryType: { const: "ReceiveWithAuthorization" },
          message: { type: "object" },
        },
        additionalProperties: false,
      },
      nonceSalt: bytes32,
      nonceDerivation: {
        type: "object",
        required: [
          "chainId",
          "adapter",
          "router",
          "token",
          "payer",
          "amount",
          "validAfter",
          "validBefore",
          "providerAgentId",
          "serviceId",
          "expectedPayee",
          "serviceRef",
          "nonceSalt",
          "recipe",
        ],
        properties: {
          chainId: { enum: [8453, 84532] },
          adapter: address,
          router: address,
          token: address,
          payer: address,
          amount: decimal,
          validAfter: decimal,
          validBefore: decimal,
          providerAgentId: decimal,
          serviceId: bytes32,
          expectedPayee: address,
          serviceRef: bytes32,
          nonceSalt: bytes32,
          recipe: { type: "string", format: "uri" },
        },
        additionalProperties: false,
      },
      nextAction: { type: "string" },
    },
    additionalProperties: false,
  };
}

function declarationInfoSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: [
      "profile",
      "x402Adapter",
      "paymentRouter",
      "serviceRef",
      "providerAgentId",
      "buyerAgentId",
      "serviceId",
      "expectedPayee",
      "skillId",
      "serviceSlug",
      "serviceVersion",
      "providerA2AUrl",
      "quote",
      "settlementMode",
    ],
    properties: {
      profile: { const: "1" },
      x402Adapter: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
      paymentRouter: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
      serviceRef: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
      providerAgentId: { type: "string", pattern: "^[0-9]+$" },
      buyerAgentId: { type: "string", pattern: "^[0-9]+$" },
      serviceId: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
      expectedPayee: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
      skillId: { type: "string" },
      serviceSlug: { type: "string" },
      serviceVersion: { type: "string" },
      providerA2AUrl: { type: "string", format: "uri" },
      quote: {
        type: "object",
        required: ["id", "signature", "expiresAt"],
        properties: {
          id: { type: "string" },
          signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
          expiresAt: { type: "string", format: "date-time" },
        },
        additionalProperties: false,
      },
      settlementMode: {
        enum: ["settle-only", "register-and-settle"],
      },
      warnings: {
        type: "array",
        items: { type: "string" },
      },
    },
    additionalProperties: true,
  };
}

export function buildDaskiX402Declaration(
  publicUrl: string,
  info: DaskiX402Info,
  signing: DaskiX402Signing,
): DaskiX402Declaration {
  return { info, schema: daskiX402SchemaRef(publicUrl), signing };
}

export function getDaskiDeclaration(
  source: PaymentRequired | PaymentPayload,
): DaskiX402Declaration | null {
  const value = source.extensions?.[DASKI_X402_EXTENSION_URI];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const declaration = value as Partial<DaskiX402Declaration>;
  if (!declaration.info || typeof declaration.info !== "object") return null;
  const info = declaration.info as DaskiX402Info;
  if (
    info.profile !== "1" ||
    !isHexAddress(info.x402Adapter) ||
    !isHexAddress(info.paymentRouter) ||
    !isHex32(info.serviceRef) ||
    !isHexAddress(info.expectedPayee)
  ) {
    return null;
  }
  return declaration as DaskiX402Declaration;
}

export function getDaskiReceipt(
  response: SettlementResponse,
): DaskiX402Receipt | null {
  const value = response.extensions?.[DASKI_X402_EXTENSION_URI];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as DaskiX402Receipt;
}
