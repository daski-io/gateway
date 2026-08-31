import { signReceiptEIP712, type EIP712SignedReceipt } from "@x402/extensions/offer-receipt";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

// Wire shape pinned to x402-foundation/x402 commit
// 94f9951a84b942921a3822f1ac2904dc3917c2d5 (2026-08-31).
export const X402_RECEIPT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    receipt: {
      type: "object",
      properties: {
        format: { type: "string" },
        payload: {
          type: "object",
          properties: {
            version: { type: "integer" },
            network: { type: "string" },
            resourceUrl: { type: "string" },
            payer: { type: "string" },
            issuedAt: { type: "integer" },
            transaction: { type: "string" },
          },
          required: ["version", "network", "resourceUrl", "payer", "issuedAt"],
        },
        signature: { type: "string" },
      },
      required: ["format", "signature"],
    },
  },
  required: ["receipt"],
} as const;

export async function createX402OfferReceipt(args: {
  privateKey: Hex;
  network: string;
  resourceUrl: string;
  payer: string;
  issuedAt: number;
  transaction: string;
}): Promise<EIP712SignedReceipt> {
  const payload = {
    version: 1,
    network: args.network,
    resourceUrl: args.resourceUrl,
    payer: args.payer,
    issuedAt: args.issuedAt,
    transaction: args.transaction,
  };
  const account = privateKeyToAccount(args.privateKey);
  const signature = await signReceiptEIP712(
    payload,
    (parameters) => account.signTypedData(parameters as Parameters<typeof account.signTypedData>[0]),
  );
  return { format: "eip712", payload, signature };
}

export function x402PaymentResponse(args: {
  receipt: EIP712SignedReceipt;
  network: string;
  payer: string;
  transaction: string;
}) {
  return {
    success: true,
    payer: args.payer,
    transaction: args.transaction,
    network: args.network,
    extensions: {
      "offer-receipt": {
        info: { receipt: args.receipt },
        schema: X402_RECEIPT_SCHEMA,
      },
    },
  };
}
