import { randomUUID } from "node:crypto";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { Router, type Request, type Response } from "express";
import type { Pool } from "../db/pool.js";
import type { ProviderAuthorityService } from "../payment/providerAuthority.js";
import { clearRawJsonBody, getRawJsonBody } from "../http/rawJsonBody.js";
import { hasDuplicateJsonObjectKeys } from "../http/jsonDuplicateKeys.js";
import {
  bazaarIngressAgeSeconds,
  clearBazaarRequestContext,
  takeBazaarPaymentHeaders,
} from "../http/bazaarRequestContext.js";
import { BazaarLifecycleService } from "./lifecycleService.js";
import { BazaarRecoveryRuntime } from "./recovery.js";
import { BazaarOutcomeService } from "./outcomeService.js";
import type { BazaarOutcomeResult } from "./outcomeHelpers.js";
import { validateStockFixedRequest } from "./requestBinding.js";
import { BazaarOrderStore } from "./store.js";
import { BazaarObservationStore } from "./observationStore.js";
import { BazaarRefundStore } from "./refundStore.js";
import { BazaarFulfillmentStore } from "./fulfillmentStore.js";
import type { BazaarCompatibilityWiring } from "./types.js";
import { reconcileListingRuntimeBindings } from "./listingStore.js";
import { snapshotBazaarCompatibilityWiring } from "./wiringSnapshot.js";
import {
  readLifecycleDomains,
  reconcileLifecycleDomains,
} from "./lifecycleDomainRegistry.js";
import { validateBazaarCompatibilityWiring } from "./wiringValidation.js";

const MAX_X402_HEADER_BYTES = 8 * 1024;
const MAX_PAYMENT_SIGNATURE_BYTES = 12 * 1024;
const MAX_LIFECYCLE_BODY_BYTES = 64 * 1024;

export async function createBazaarCompatibilityRouter(options: {
  pool: Pool;
  providerAuthority: ProviderAuthorityService;
  wiring: BazaarCompatibilityWiring;
  lifecycleDomainRetentionSeconds: number;
  shutdownSignal?: AbortSignal;
}): Promise<{ router: Router; close(): Promise<void>; recovery: BazaarRecoveryRuntime }> {
  const wiring = snapshotBazaarCompatibilityWiring(options.wiring);
  await validateBazaarCompatibilityWiring(wiring);
  await reconcileListingRuntimeBindings({
    pool: options.pool,
    activeListings: wiring.listings,
    recoveryListings: wiring.recoveryListings,
  });
  await reconcileLifecycleDomains({
    pool: options.pool,
    listings: wiring.listings,
    retiredCommitments: wiring.retiredLifecycleCommitments,
    providerActionSigner: wiring.providerActionSigningBroker.address,
    refundInstructionSigner: wiring.refundInstructionSigningBroker.address,
    providerRefundWallets: Object.values(wiring.refundRiskPolicies).map(
      (policy) => policy.refundWallet,
    ),
    retentionSeconds: options.lifecycleDomainRetentionSeconds,
  });
  const router = Router();
  const store = new BazaarOrderStore(options.pool);
  const observationStore = new BazaarObservationStore(options.pool);
  const refundStore = new BazaarRefundStore(options.pool);
  const fulfillmentStore = new BazaarFulfillmentStore(options.pool);
  const leaseOwner = `gateway-request:${randomUUID()}`;
  const lifecycle = new BazaarLifecycleService(store, wiring, options.shutdownSignal);
  const recovery = new BazaarRecoveryRuntime(
    store,
    observationStore,
    refundStore,
    fulfillmentStore,
    wiring,
    options.providerAuthority,
  );

  router.get("/.well-known/daski-bazaar-lifecycle-domains-v1.json", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const now = BigInt(Math.floor((wiring.now?.() ?? new Date()).getTime() / 1000));
    const retainedKeys = (wiring.challengeMac.retained ?? [])
      .filter((key) => key.acceptUntil >= now)
      .map((key) => ({
        epoch: key.epoch,
        status: "retained",
        acceptUntil: key.acceptUntil.toString(),
      }));
    res.json({
      version: "1",
      providerActionSigner: wiring.providerActionSigningBroker.address,
      challengeMacKeys: [
        { epoch: wiring.challengeMac.current.epoch, status: "current" },
        ...retainedKeys,
      ],
      domains: await readLifecycleDomains(options.pool),
    });
  });

  for (const listing of wiring.listings) {
    const service = new BazaarOutcomeService(
      listing,
      store,
      wiring,
      options.providerAuthority,
      leaseOwner,
      options.shutdownSignal,
    );
    router.post(listing.routePath, async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const request = validateStockFixedRequest(req, listing.offer.message);
        if (!request.ok) {
          res.status(request.status).json({ error: request.code });
          return;
        }
        const headers = takeBazaarPaymentHeaders(req);
        if (headers.legacyPaymentPresent) {
          res.status(400).json({ error: "legacy_payment_header_forbidden" });
          return;
        }
        const rawHeader = headers.paymentSignature;
        if (rawHeader === undefined) {
          await sendOutcome(res, await service.unpaid());
          return;
        }
        if (
          Array.isArray(rawHeader) ||
          rawHeader.length === 0 ||
          Buffer.byteLength(rawHeader, "utf8") > MAX_PAYMENT_SIGNATURE_BYTES ||
          !validPaymentSignatureJson(rawHeader)
        ) {
          res.status(400).json({ error: "malformed_payment_signature" });
          return;
        }
        let payload;
        try {
          payload = decodePaymentSignatureHeader(rawHeader);
        } catch {
          res.status(400).json({ error: "malformed_payment_signature" });
          return;
        }
        await sendOutcome(
          res,
          await service.paid(payload, bazaarIngressAgeSeconds(req)),
        );
      } finally {
        clearRawJsonBody(req);
        clearBazaarRequestContext(req);
      }
    });
  }

  router.post("/x402/v1/orders/:handle/challenge", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!validLifecycleRequest(req)) {
      discardLifecycleRequest(req);
      res.status(400).json({ error: "invalid_lifecycle_request" });
      return;
    }
    const result = await runLifecycleRequest(
      req,
      () => lifecycle.challenge(req.params.handle, req.body),
    );
    res.status(result.status).json(result.body);
  });
  router.post("/x402/v1/orders/:handle/actions", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!validLifecycleRequest(req)) {
      discardLifecycleRequest(req);
      res.status(400).json({ error: "invalid_lifecycle_request" });
      return;
    }
    const result = await runLifecycleRequest(
      req,
      () => lifecycle.redeem(req.params.handle, req.body),
    );
    res.status(result.status).json(result.body);
  });
  await recovery.start();
  return { router, close: () => recovery.close(), recovery };
}

async function sendOutcome(
  response: Response,
  result: BazaarOutcomeResult,
): Promise<void> {
  if (result.paymentRequired) {
    const header = encodePaymentRequiredHeader(result.paymentRequired);
    if (Buffer.byteLength(header, "utf8") >= MAX_X402_HEADER_BYTES) {
      response.status(503).json({ error: "listing_unavailable" });
      return;
    }
    response.setHeader("PAYMENT-REQUIRED", header);
  }
  if (result.paymentResponse) {
    const header = encodePaymentResponseHeader(result.paymentResponse);
    if (Buffer.byteLength(header, "utf8") >= MAX_X402_HEADER_BYTES) {
      response.status(503).json({ error: "payment_response_unavailable" });
      return;
    }
    response.setHeader("PAYMENT-RESPONSE", header);
  }
  response.status(result.status).json(result.body);
}

function validLifecycleRequest(request: Request): boolean {
  const contentType = request.get("content-type")?.toLowerCase();
  const rawBody = getRawJsonBody(request);
  return !request.originalUrl.includes("?") &&
    request.headers["content-encoding"] === undefined &&
    request.headers["transfer-encoding"] === undefined &&
    (contentType === "application/json" ||
      contentType === "application/json; charset=utf-8") &&
    rawBody.length > 0 && rawBody.length <= MAX_LIFECYCLE_BODY_BYTES &&
    !hasDuplicateJsonObjectKeys(rawBody);
}

async function runLifecycleRequest(
  request: Request,
  action: () => ReturnType<BazaarLifecycleService["challenge"]>,
): Promise<Awaited<ReturnType<BazaarLifecycleService["challenge"]>>> {
  try {
    return await action();
  } finally {
    discardLifecycleRequest(request);
  }
}

function discardLifecycleRequest(request: Request): void {
  clearRawJsonBody(request);
  clearBazaarRequestContext(request);
  request.body = {};
}

function validPaymentSignatureJson(header: string): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(header)) {
    return false;
  }
  const bytes = Buffer.from(header, "base64");
  return !hasDuplicateJsonObjectKeys(bytes);
}
