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
import { isHexAddress } from "../util/evmValidation.js";
import { BazaarLifecycleService } from "./lifecycleService.js";
import { validateChallengeMacKeyring } from "./lifecycleChallenge.js";
import { BazaarRecoveryRuntime } from "./recovery.js";
import { validateCompatibilityListing } from "./offer.js";
import { BazaarOutcomeService } from "./outcomeService.js";
import type { BazaarOutcomeResult } from "./outcomeHelpers.js";
import { validateStockFixedRequest } from "./requestBinding.js";
import { BazaarOrderStore } from "./store.js";
import type { BazaarCompatibilityWiring } from "./types.js";
import { registerListingBindings } from "./listingStore.js";
import { validateSettlementCapacityPolicy } from "./settlementCapacity.js";
import { validateRefundRiskPolicies } from "./refundPolicy.js";
import { snapshotBazaarCompatibilityWiring } from "./wiringSnapshot.js";
import {
  readLifecycleDomains,
  reconcileLifecycleDomains,
} from "./lifecycleDomainRegistry.js";

const MAX_X402_HEADER_BYTES = 8 * 1024;
const MAX_PAYMENT_SIGNATURE_BYTES = 12 * 1024;
const MAX_LIFECYCLE_BODY_BYTES = 64 * 1024;

export async function createBazaarCompatibilityRouter(options: {
  pool: Pool;
  providerAuthority: ProviderAuthorityService;
  wiring: BazaarCompatibilityWiring;
  lifecycleDomainRetentionSeconds: number;
}): Promise<{ router: Router; close(): Promise<void>; recovery: BazaarRecoveryRuntime }> {
  const wiring = snapshotBazaarCompatibilityWiring(options.wiring);
  await validateWiring(wiring);
  await registerListingBindings(options.pool, wiring.listings);
  await reconcileLifecycleDomains({
    pool: options.pool,
    listings: wiring.listings,
    retiredCommitments: wiring.retiredLifecycleCommitments,
    providerActionSigner: wiring.providerActionSigningBroker.address,
    retentionSeconds: options.lifecycleDomainRetentionSeconds,
  });
  const router = Router();
  const store = new BazaarOrderStore(options.pool);
  const leaseOwner = `gateway-request:${randomUUID()}`;
  const lifecycle = new BazaarLifecycleService(store, wiring);
  const recovery = new BazaarRecoveryRuntime(
    store,
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

async function validateWiring(wiring: BazaarCompatibilityWiring): Promise<void> {
  const publicOrigin = validatePublicOrigin(wiring.publicOrigin);
  const termsOrigins = validateApprovedTermsOrigins(wiring.approvedTermsOrigins);
  const routes = new Set<string>();
  const recipients = new Set<string>();
  const commitments = new Set<string>();
  const retiredCommitments = new Set<string>();
  const offerIds = new Map<string, string>();
  const providerActionSigner = wiring.providerActionSigningBroker.address.toLowerCase();
  const zeroAddress = `0x${"00".repeat(20)}`;
  const now = BigInt(Math.floor((wiring.now?.() ?? new Date()).getTime() / 1000));
  validateChallengeMacKeyring(wiring.challengeMac, now);
  validateSettlementCapacityPolicy(wiring.settlementCapacity);
  validateRefundRiskPolicies(wiring.refundRiskPolicies, wiring.listings);
  for (const commitment of wiring.retiredLifecycleCommitments) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) {
      throw new Error("Bazaar retired lifecycle commitment is malformed");
    }
    const normalized = commitment.toLowerCase();
    if (retiredCommitments.has(normalized)) {
      throw new Error("Bazaar retired lifecycle commitments must be unique");
    }
    retiredCommitments.add(normalized);
  }
  if (
    !isHexAddress(wiring.providerActionSigningBroker.address) ||
    providerActionSigner === zeroAddress
  ) throw new Error("Bazaar provider-action signer must be valid");
  for (const listing of wiring.listings) {
    await validateCompatibilityListing(listing, now);
    const offer = listing.offer.message;
    if (new URL(listing.resourceUrl).origin !== publicOrigin) {
      throw new Error("Bazaar resource URL does not use the canonical public origin");
    }
    if (!termsOrigins.has(new URL(listing.termsUrl).origin)) {
      throw new Error("Bazaar terms URL does not use an approved publication origin");
    }
    if (
      providerActionSigner === offer.offerSigner.toLowerCase() ||
      providerActionSigner === offer.payTo.toLowerCase()
    ) throw new Error("Bazaar lifecycle keys cannot reuse listing or payment keys");
    if (offer.chainId !== 84532n) {
      throw new Error("Bazaar compatibility harness is Base Sepolia only");
    }
    const route = listing.routePath;
    const recipient = offer.payTo.toLowerCase();
    const commitment = offer.listingCommitment.toLowerCase();
    if (
      routes.has(route) || recipients.has(recipient) || commitments.has(commitment) ||
      retiredCommitments.has(commitment)
    ) {
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

function validatePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Bazaar public origin is invalid");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash || url.pathname !== "/" || value !== url.origin
  ) throw new Error("Bazaar public origin is invalid");
  return url.origin;
}

function validateApprovedTermsOrigins(origins: string[]): Set<string> {
  const approved = new Set<string>();
  for (const value of origins) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Bazaar approved terms origin is invalid");
    }
    if (
      url.protocol !== "https:" || url.username || url.password || url.search ||
      url.hash || url.pathname !== "/" || value !== url.origin || approved.has(value)
    ) throw new Error("Bazaar approved terms origin is invalid");
    approved.add(value);
  }
  if (approved.size === 0) throw new Error("Bazaar has no approved terms origin");
  return approved;
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
