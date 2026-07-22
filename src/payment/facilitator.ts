import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { Queries } from "../db/queries.js";
import type { FetchAgentCardOptions } from "../identity/fetch-agent-card.js";
import { verifyPaymentPayload } from "./verify.js";
import { settleChallenge } from "./settlementCoordinator.js";
import type { Hex, PaymentPayload, PaymentRequirements } from "../types.js";
import { isHex32 } from "../util/evmValidation.js";
import type { PaymentScreeningReadinessProbe } from "./screeningReadiness.js";

export interface FacilitatorDeps {
  config: Config;
  queries: Queries;
  reader: ChainReader;
  screeningReadiness: PaymentScreeningReadinessProbe;
  /**
   * Optional test seam for the buyer-side agentURI fetcher used by the
   * atomic register-and-settle path. The default `safeFetch` is right
   * for production; tests stub it via the gateway's `buyerAgentCardFetch`.
   * The atomic path uses this to resolve a display name from the buyer's
   * signed agentURI so `buyer_identities` is populated alongside the
   * fresh agent mint.
   */
  fetchAgentCardFn?: FetchAgentCardOptions["fetchFn"];
}

interface FacilitatorBody {
  x402Version?: number;
  paymentPayload?: PaymentPayload;
  paymentRequirements?: PaymentRequirements;
  // Daski extension. When the challenge was issued for an unregistered
  // buyer (challenge.buyerTokenId === 0), the agent must include this
  // field with a fresh RegisterAgent EIP-712 signature. The gateway then
  // routes to settleWithRegistration so registration + settlement live in
  // one tx — i.e. the USDC payment is the Sybil tax for the new agentId.
  registration?: {
    agentURI?: string;
    deadline?: string;
    signature?: string;
  };
}

function parseOptionalProviderTokenId(value: unknown): bigint | null | { error: string } {
  if (value == null || value === "") return null;
  if ((typeof value !== "string" && typeof value !== "number") || !/^[0-9]+$/.test(String(value))) {
    return { error: "paymentRequirements providerTokenId must be numeric" };
  }
  try {
    return BigInt(value);
  } catch {
    return { error: "paymentRequirements providerTokenId is out of range" };
  }
}

function badRequest(res: Response, message: string) {
  res.status(400).json({
    isValid: false,
    invalidReason: message,
    payer: null,
  });
}

/** Pull the Daski serviceRef from the canonical requirements extension. */
function extractServiceRef(body: FacilitatorBody): Hex | null {
  const req = body.paymentRequirements;
  const fromRequirements = req?.extra?.daski?.serviceRef;
  if (isHex32(fromRequirements)) return fromRequirements.toLowerCase() as Hex;
  return null;
}

export function createFacilitatorRouter(deps: FacilitatorDeps): Router {
  const router = Router();

  router.post("/verify", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as FacilitatorBody;
    if (!body.paymentPayload || !body.paymentRequirements) {
      badRequest(res, "paymentPayload and paymentRequirements are required");
      return;
    }

    const serviceRef = extractServiceRef(body);
    if (!serviceRef) {
      badRequest(res, "paymentRequirements.extra.daski.serviceRef missing or malformed");
      return;
    }

    const challenge = await deps.queries.getChallengeByRef(serviceRef);
    if (!challenge) {
      badRequest(res, "no challenge found for the given serviceRef");
      return;
    }
    const result = await verifyPaymentPayload(
      { payload: body.paymentPayload, challenge },
      deps.config,
      deps.reader,
    );

    if (!result.ok) {
      res.status(200).json({
        isValid: false,
        invalidReason: result.message,
        payer: result.payer,
      });
      return;
    }
    res.status(200).json({
      isValid: true,
      invalidReason: null,
      payer: result.payer,
    });
  });

  router.post("/settle", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as FacilitatorBody;
    if (!body.paymentPayload || !body.paymentRequirements) {
      res.status(400).json({
        success: false,
        errorReason: "paymentPayload and paymentRequirements are required",
      });
      return;
    }

    const serviceRef = extractServiceRef(body);
    if (!serviceRef) {
      res.status(400).json({
        success: false,
        errorReason: "paymentRequirements.extra.daski.serviceRef missing or malformed",
      });
      return;
    }

    const challenge = await deps.queries.getChallengeByRef(serviceRef);
    if (!challenge) {
      res.status(404).json({
        success: false,
        errorReason: "no challenge found for the given serviceRef",
      });
      return;
    }
    if (
      challenge.settlementState !== "paid" &&
      challenge.settlementState !== "sanctions_rejected" &&
      !(await deps.screeningReadiness.isReady())
    ) {
      res.status(503).json({
        success: false,
        errorReason: "payment_screening_unready",
        message: "Payment cannot be processed right now. Please try again later.",
        retryable: true,
        transaction: challenge.transactionHash ?? "",
        network: deps.config.network,
        payer: challenge.walletAddress,
      });
      return;
    }
    // Defence-in-depth: the URL segment is gone under this endpoint, so
    // bind the challenge to the providerTokenId advertised in the
    // paymentRequirements extra block.
    const rawRequirementsProviderId = body.paymentRequirements?.extra?.daski?.providerTokenId;
    const requirementsProviderId = parseOptionalProviderTokenId(rawRequirementsProviderId);
    if (requirementsProviderId !== null && typeof requirementsProviderId === "object") {
      res.status(400).json({
        success: false,
        errorReason: requirementsProviderId.error,
      });
      return;
    }
    if (requirementsProviderId !== null && requirementsProviderId !== challenge.providerTokenId) {
      res.status(400).json({
        success: false,
        errorReason: "paymentRequirements providerTokenId does not match stored challenge",
      });
      return;
    }

    const coordinated = await settleChallenge(
      {
        config: deps.config,
        reader: deps.reader,
        queries: deps.queries,
        fetchAgentCardFn: deps.fetchAgentCardFn,
      },
      {
        challenge,
        paymentPayload: body.paymentPayload,
        registration: body.registration,
      },
    );
    if (coordinated.kind === "registration-required") {
      res.status(400).json({
        success: false,
        errorReason: "registration_required",
        transaction: "",
        network: deps.config.network,
        payer: (body.paymentPayload?.payload?.authorization?.from?.toLowerCase() ?? "") as Hex,
      });
      return;
    }
    if (coordinated.kind === "invalid-registration") {
      res.status(400).json({
        success: false,
        errorReason: "invalid_registration",
        message: coordinated.message,
      });
      return;
    }
    const result = coordinated.result;

    // Spec base fields: success / errorReason / transaction / network /
    // payer. Daski extension: paymentId, serviceRef, providerTokenId,
    // buyerTokenId, skillId, amount, providerA2AUrl, and provider quote
    // credentials — flat, not nested.
    // Third-party x402 clients ignore the extras; Daski skills read them.
    if (!result.ok) {
      res.status(result.status).json({
        success: false,
        errorReason: result.errorReason,
        message: result.message,
        ...(result.screeningFailure
          ? { retryable: result.screeningFailure.retryable }
          : {}),
        transaction: result.response.transaction,
        network: result.response.network,
        payer: result.response.payer,
        paymentId: null,
        serviceRef,
        providerTokenId: challenge.providerTokenId.toString(),
        buyerTokenId: challenge.buyerTokenId.toString(),
        skillId: challenge.skillId,
        amount: challenge.amount.toString(),
        providerA2AUrl: challenge.providerA2AUrl,
        quoteId: challenge.quoteId,
        quoteSignature: challenge.quoteSignature,
      });
      return;
    }

    const daski = result.response.daski;
    res.status(200).json({
      success: true,
      errorReason: null,
      transaction: result.response.transaction,
      network: result.response.network,
      payer: result.response.payer,
      paymentId: daski?.paymentId ?? null,
      serviceRef: daski?.serviceRef ?? serviceRef,
      providerTokenId: daski?.providerTokenId ?? challenge.providerTokenId.toString(),
      buyerTokenId: daski?.buyerTokenId ?? challenge.buyerTokenId.toString(),
      skillId: challenge.skillId,
      amount: daski?.amount ?? challenge.amount.toString(),
      providerA2AUrl: daski?.providerA2AUrl ?? challenge.providerA2AUrl,
      registered: daski?.registered ?? false,
      quoteId: daski?.quoteId ?? challenge.quoteId,
      quoteSignature: daski?.quoteSignature ?? challenge.quoteSignature,
    });
  });

  return router;
}
