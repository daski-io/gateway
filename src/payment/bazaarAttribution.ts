import type { Response } from "express";
import {
  SettlementTransactionRevertedError,
  type ChainReader,
} from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { Hex, StoredChallenge } from "../types.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import type { BazaarPayment } from "./bazaarPayment.js";
import { receiptBody, setSettlementHeaders } from "./bazaarResponse.js";
import {
  persistSettlementEvent,
  validateSettlementEvent,
} from "./verify.js";

export async function attributeBazaarPayment(args: {
  response: Response;
  core: BazaarPayment;
  challenge: StoredChallenge | null;
  authorizationConsumed: boolean;
  from: Hex;
  authNonce: Hex;
  skillId: string;
  serviceArgs: Record<string, unknown>;
  config: Config;
  queries: Queries;
  reader: ChainReader;
}): Promise<void> {
  const { response, core, config, queries, reader } = args;
  let challenge = args.challenge;
  if (!challenge) {
    response.status(500).json({
      x402Version: core.version,
      error: "challenge row missing before attribution",
    });
    return;
  }
  if (
    args.authorizationConsumed &&
    (challenge.settlementState === "pending" ||
      challenge.settlementState === "expired")
  ) {
    const recorded =
      await queries.recordChallengeExternalAuthorizationConsumed(
        challenge.serviceRef,
      );
    if (!recorded) {
      response.status(409).json({
        x402Version: core.version,
        error: "payment authorization was consumed but state could not be persisted",
      });
      return;
    }
    challenge = { ...challenge, settlementState: "external_settled" };
  }

  let attribution: Awaited<
    ReturnType<ChainReader["attributeDirectTransfer"]>
  >;
  try {
    attribution = challenge.transactionHash
      ? await reader.getSettlementByTransaction(
          challenge.transactionHash,
          challenge.serviceRef,
        )
      : await queries.withFacilitatorTransactionLock((release) =>
          reader.attributeDirectTransfer(
            {
              providerAgentId: challenge.providerTokenId,
              serviceId: challenge.serviceId,
              amount: challenge.amount,
              serviceRef: challenge.serviceRef,
              from: args.from,
              authNonce: args.authNonce,
            },
            async (transactionHash) => {
              const recorded =
                await queries.recordChallengeTransactionBroadcast(
                  challenge.serviceRef,
                  transactionHash,
                );
              if (!recorded) {
                throw new Error(
                  "unable to persist attribution transaction broadcast",
                );
              }
              await release();
            },
          ),
        );
  } catch (error) {
    if (error instanceof SettlementTransactionRevertedError) {
      const latest = await queries.getChallengeByRef(challenge.serviceRef);
      if (latest?.transactionHash) {
        await queries.clearChallengeTransactionBroadcast(
          challenge.serviceRef,
          latest.transactionHash,
        );
      }
    }
    response.status(502).json({
      x402Version: core.version,
      error: "attribution_pending",
      message: `${publicErrorMessage(
        "bazaar.attributeDirectTransfer",
        error,
        "payment settled on-chain but the commission split has not run",
      )}. Retry this exact request — the gateway resumes at attribution without re-charging.`,
      settlementTransaction: challenge.externalSettleTx,
      serviceRef: challenge.serviceRef,
    });
    return;
  }
  const eventError = validateSettlementEvent(challenge, attribution.event, true);
  if (eventError) {
    response.status(500).json({
      x402Version: core.version,
      error: "unexpected_settlement_event",
      message: eventError,
    });
    return;
  }
  const recorded = await persistSettlementEvent(
    queries,
    challenge,
    attribution.event,
    attribution.transactionHash,
    attribution.event.buyerAgentId,
  );
  if (!recorded) {
    response.status(500).json({
      x402Version: core.version,
      error: "settlement_persistence_conflict",
      message: "on-chain settlement conflicts with the stored payment challenge",
      serviceRef: challenge.serviceRef,
    });
    return;
  }
  setSettlementHeaders(response, {
    success: true,
    transaction: challenge.externalSettleTx ?? attribution.transactionHash,
    network: config.network,
    payer: args.from,
  });
  response.status(200).json(
    receiptBody(
      config,
      {
        skillId: challenge.skillId ?? args.skillId,
        providerA2AUrl: challenge.providerA2AUrl,
      },
      {
        paymentId: attribution.event.paymentId.toString(),
        serviceRef: challenge.serviceRef,
        providerTokenId: challenge.providerTokenId.toString(),
        buyerTokenId: attribution.event.buyerAgentId.toString(),
        amount: attribution.event.totalAmount.toString(),
        settlementTransaction:
          challenge.externalSettleTx ?? attribution.transactionHash,
        attributionTransaction: attribution.transactionHash,
        quoteId: challenge.quoteId,
        quoteSignature: challenge.quoteSignature,
        serviceArgs: args.serviceArgs,
      },
    ),
  );
}
