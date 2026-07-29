import { DASKI_X402_EXTENSION_URI } from "../config.js";
import type {
  DaskiX402Declaration,
  DaskiX402Info,
  DaskiX402Receipt,
  PaymentPayload,
  PaymentRequired,
  SettlementResponse,
} from "../types.js";
import { isHex32, isHexAddress } from "../util/evmValidation.js";

export const DASKI_X402_SCHEMA_PATH =
  "/.well-known/x402-daski-v2.schema.json";

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
    ],
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
    },
    additionalProperties: true,
  };
}

export function buildDaskiX402Declaration(
  publicUrl: string,
  info: DaskiX402Info,
): DaskiX402Declaration {
  return { info, schema: daskiX402Schema(publicUrl) };
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
    !isHex32(info.serviceRef)
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
