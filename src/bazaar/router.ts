import { randomUUID } from "node:crypto";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { Router, type Request, type Response } from "express";
import type { Pool } from "../db/pool.js";
import type { ProviderAuthorityService } from "../payment/providerAuthority.js";
import { getRawJsonBody } from "../http/rawJsonBody.js";
import { isHexAddress } from "../util/evmValidation.js";
import { BazaarLifecycleService } from "./lifecycleService.js";
import { BazaarRecoveryRuntime } from "./recovery.js";
import { validateCompatibilityListing } from "./offer.js";
import { BazaarOutcomeService } from "./outcomeService.js";
import type { BazaarOutcomeResult } from "./outcomeHelpers.js";
import { validateStockFixedRequest } from "./requestBinding.js";
import { BazaarOrderStore } from "./store.js";
import type { BazaarCompatibilityWiring } from "./types.js";
import { registerListingBindings } from "./listingStore.js";

const MAX_X402_HEADER_BYTES = 8 * 1024;
const MAX_PAYMENT_SIGNATURE_BYTES = 12 * 1024;
const MAX_LIFECYCLE_BODY_BYTES = 64 * 1024;

export async function createBazaarCompatibilityRouter(options: {
  pool: Pool;
  providerAuthority: ProviderAuthorityService;
  wiring: BazaarCompatibilityWiring;
}): Promise<{ router: Router; close(): Promise<void>; recovery: BazaarRecoveryRuntime }> {
  await validateWiring(options.wiring);
  await registerListingBindings(options.pool, options.wiring.listings);
  const router = Router();
  const store = new BazaarOrderStore(options.pool);
  const leaseOwner = `gateway-request:${randomUUID()}`;
  const lifecycle = new BazaarLifecycleService(store, options.wiring);
  const recovery = new BazaarRecoveryRuntime(
    store,
    options.wiring,
    options.providerAuthority,
  );

  for (const listing of options.wiring.listings) {
    const service = new BazaarOutcomeService(
      listing,
      store,
      options.wiring,
      options.providerAuthority,
      leaseOwner,
    );
    router.post(listing.routePath, async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const request = validateStockFixedRequest(req, listing.offer.message);
      if (!request.ok) {
        res.status(request.status).json({ error: request.code });
        return;
      }
      if (hasLegacyPaymentHeader(req)) {
        res.status(400).json({ error: "legacy_payment_header_forbidden" });
        return;
      }
      const rawHeader = req.headers["payment-signature"];
      if (rawHeader === undefined) {
        await sendOutcome(res, await service.unpaid());
        return;
      }
      if (
        Array.isArray(rawHeader) ||
        rawHeader.length === 0 ||
        Buffer.byteLength(rawHeader, "utf8") > MAX_PAYMENT_SIGNATURE_BYTES
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
      await sendOutcome(res, await service.paid(payload));
    });
  }

  router.post("/x402/v1/orders/:handle/challenge", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!validLifecycleRequest(req)) {
      res.status(400).json({ error: "invalid_lifecycle_request" });
      return;
    }
    const result = await lifecycle.challenge(req.params.handle, req.body);
    res.status(result.status).json(result.body);
  });
  router.post("/x402/v1/orders/:handle/actions", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!validLifecycleRequest(req)) {
      res.status(400).json({ error: "invalid_lifecycle_request" });
      return;
    }
    const result = await lifecycle.redeem(req.params.handle, req.body);
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

async function validateWiring(wiring: BazaarCompatibilityWiring): Promise<void> {
  if (wiring.listings.length === 0) throw new Error("Bazaar harness has no listings");
  const routes = new Set<string>();
  const recipients = new Set<string>();
  const commitments = new Set<string>();
  const offerIds = new Map<string, string>();
  const challengeSigner = wiring.challengeSigner.address.toLowerCase();
  const providerActionSigner = wiring.providerActionSigner.address.toLowerCase();
  const zeroAddress = `0x${"00".repeat(20)}`;
  if (
    !isHexAddress(wiring.challengeSigner.address) ||
    !isHexAddress(wiring.providerActionSigner.address) ||
    challengeSigner === zeroAddress || providerActionSigner === zeroAddress ||
    challengeSigner === providerActionSigner
  ) throw new Error("Bazaar lifecycle signers must be valid and purpose-separated");
  const now = BigInt(Math.floor((wiring.now?.() ?? new Date()).getTime() / 1000));
  for (const listing of wiring.listings) {
    await validateCompatibilityListing(listing, now);
    const offer = listing.offer.message;
    if (
      challengeSigner === offer.offerSigner.toLowerCase() ||
      challengeSigner === offer.payTo.toLowerCase() ||
      providerActionSigner === offer.offerSigner.toLowerCase() ||
      providerActionSigner === offer.payTo.toLowerCase()
    ) throw new Error("Bazaar lifecycle keys cannot reuse listing or payment keys");
    if (offer.chainId !== 84532n) {
      throw new Error("Bazaar compatibility harness is Base Sepolia only");
    }
    const route = listing.routePath;
    const recipient = offer.payTo.toLowerCase();
    const commitment = offer.listingCommitment.toLowerCase();
    if (routes.has(route) || recipients.has(recipient) || commitments.has(commitment)) {
      throw new Error("Bazaar listings must have unique routes, payTo values, and commitments");
    }
    routes.add(route);
    recipients.add(recipient);
    commitments.add(commitment);
    const offerId = offer.offerId.toLowerCase();
    const offerHash = JSON.stringify(offer, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    const priorOffer = offerIds.get(offerId);
    if (priorOffer !== undefined && priorOffer !== offerHash) {
      throw new Error("one Bazaar offerId cannot identify two offer bodies");
    }
    offerIds.set(offerId, offerHash);
  }
}

function validLifecycleRequest(request: Request): boolean {
  const contentType = request.get("content-type")?.toLowerCase();
  const rawBody = getRawJsonBody(request);
  return !request.originalUrl.includes("?") &&
    request.headers["content-encoding"] === undefined &&
    request.headers["transfer-encoding"] === undefined &&
    (contentType === "application/json" ||
      contentType === "application/json; charset=utf-8") &&
    rawBody.length > 0 && rawBody.length <= MAX_LIFECYCLE_BODY_BYTES;
}

function hasLegacyPaymentHeader(request: Request): boolean {
  return request.headers["x-payment"] !== undefined;
}
