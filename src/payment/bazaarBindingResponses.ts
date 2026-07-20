import type { Response } from "express";
import type { StoredChallenge } from "../types.js";
import type { ParsedBazaarAuthorization } from "./bazaarAuthorization.js";
import type { BazaarDeps, BazaarRequestContext } from "./bazaarRequest.js";
import { receiptBody, setSettlementHeaders } from "./bazaarResponse.js";

export function sendStoredReceipt(
  response: Response,
  request: BazaarRequestContext,
  authorization: ParsedBazaarAuthorization,
  challenge: StoredChallenge,
  deps: BazaarDeps,
): void {
  if (challenge.paymentId === null) {
    throw new Error("paid challenge is missing its payment id");
  }
  setSettlementHeaders(response, {
    success: true,
    transaction: challenge.externalSettleTx ?? challenge.transactionHash ?? "",
    network: deps.config.network,
    payer: authorization.from,
  });
  response.status(200).json(
    receiptBody(
      deps.config,
      {
        skillId: challenge.skillId ?? request.skillId,
        providerA2AUrl: challenge.providerA2AUrl,
      },
      {
        paymentId: challenge.paymentId.toString(),
        serviceRef: challenge.serviceRef,
        providerTokenId: challenge.providerTokenId.toString(),
        buyerTokenId: challenge.buyerTokenId.toString(),
        amount: challenge.amount.toString(),
        settlementTransaction: challenge.externalSettleTx,
        attributionTransaction: challenge.transactionHash,
        quoteId: challenge.quoteId,
        quoteSignature: challenge.quoteSignature,
        serviceArgs: request.serviceArgs,
      },
    ),
  );
}

export function sendRegistrationRequired(
  response: Response,
  request: BazaarRequestContext,
  deps: BazaarDeps,
): void {
  response.status(403).json({
    x402Version: 2,
    error: "buyer_not_registered",
    message:
      "This wallet has no Daski (ERC-8004) identity. Register first, then retry.",
    register: {
      prep: `${deps.config.publicUrl}/register-prep`,
      transaction: `${deps.config.publicUrl}/register-transaction`,
      mcp: `${deps.config.publicUrl}${deps.config.mcpPath}`,
      gasPaidBy: "buyer",
    },
    resource: request.resourceUrl,
  });
}
