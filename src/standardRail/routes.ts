import { walletChallengeEnvelope } from "./wireEnvelopes.js";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { decodePaymentHeader, encodedPaymentRequiredHeader } from "./payment.js";
import type { StandardRailService } from "./service.js";
import {
  asStandardRailError,
  isTransientDatabaseError,
  logStandardRailError,
  standardRailError,
  standardRailPublicError,
} from "./errors.js";

const PAYMENT_HEADER = "payment-signature";
const ORDER_ACTIONS = [
  "status",
  "input",
  "cancel",
  "artifact",
  "support",
  "confirmation",
  "revoke-confirmation",
  "grant-read",
] as const;

type OrderAction = typeof ORDER_ACTIONS[number];

const CONFIRMATION_HTTP_ERRORS = new Map<string, { code: string; status: number }>([
  ["REPUTATION_NOT_READY", { code: "REPUTATION_NOT_READY", status: 409 }],
  ["REPUTATION_UNAVAILABLE", { code: "REPUTATION_UNAVAILABLE", status: 503 }],
  ["CONFIRMATION_SPONSORSHIP_LIMIT", { code: "CONFIRMATION_SPONSORSHIP_LIMITED", status: 503 }],
  ["CONFIRMATION_SPONSORSHIP_LIMITED", { code: "CONFIRMATION_SPONSORSHIP_LIMITED", status: 503 }],
  ["CONFIRMATION_SPONSORSHIP_UNAVAILABLE", { code: "CONFIRMATION_SPONSORSHIP_UNAVAILABLE", status: 503 }],
  ["CONFIRMATION_SUBMISSION_PENDING", { code: "CONFIRMATION_SUBMISSION_PENDING", status: 409 }],
]);

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function assertExactKeys(value: unknown, expected: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("REQUEST_BODY_INVALID");
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error("REQUEST_BODY_FIELDS_INVALID");
  }
}

function assertStandardExactKeys(
  value: unknown,
  expected: readonly string[],
  field: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw standardRailError("REQUEST_SCHEMA_INVALID", {
      field,
      expected: { fields: [...expected] },
    });
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length ||
      actual.some((key, index) => key !== required[index])) {
    throw standardRailError("REQUEST_SCHEMA_INVALID", {
      field,
      expected: { fields: required },
    });
  }
}

const KNOWN_WALLET_REFUSALS = new Set([
  "wallet authorization denied", "WALLET_QUERY_INVALID", "WALLET_RATE_LIMITED",
  "ASSET_ACTION_NOT_ADMITTED", "ASSET_ACTION_REJECTED",
  "ASSET_DESTRUCTIVE_CONFIRMATION_REQUIRED", "ASSET_DESTRUCTIVE_DELAY_ACTIVE",
]);

function sendWalletError(
  res: import("express").Response,
  error: unknown,
  fallback = "WALLET_ACCESS_DENIED",
): void {
  if (isTransientDatabaseError(error)) {
    // Not a client fault: the same request retried unchanged will succeed.
    res.setHeader("Retry-After", "1");
    res.status(503).json({ error: {
      code: "WALLET_TEMPORARILY_UNAVAILABLE",
      message: "The wallet request could not be completed right now; retry it unchanged",
    } });
    return;
  }
  const internal = error instanceof Error ? error.message : fallback;
  if (!KNOWN_WALLET_REFUSALS.has(internal)) {
    logStandardRailError(standardRailError("INTERNAL_ERROR", {
      phase: "lifecycle_auth",
      internalMessage: `wallet request failed unexpectedly: ${internal}`,
      cause: error,
    }));
  }
  const code = internal === "WALLET_QUERY_INVALID" ? "WALLET_QUERY_INVALID"
    : internal === "WALLET_RATE_LIMITED" ? "WALLET_RATE_LIMITED"
      : internal === "ASSET_ACTION_NOT_ADMITTED" ? "ASSET_ACTION_NOT_ADMITTED"
        : internal === "ASSET_ACTION_REJECTED" ? "ASSET_ACTION_REJECTED" : fallback;
  const publicCode = ["ASSET_DESTRUCTIVE_CONFIRMATION_REQUIRED", "ASSET_DESTRUCTIVE_DELAY_ACTIVE"]
    .includes(internal) ? internal : code;
  const status = publicCode === "WALLET_QUERY_INVALID" ? 400
    : publicCode === "WALLET_RATE_LIMITED" ? 429
      : publicCode.startsWith("ASSET_") ? 409 : 401;
  if (status === 429) res.setHeader("Retry-After", "60");
  res.status(status).json({ error: { code: publicCode, message: publicCode === "WALLET_ACCESS_DENIED"
    ? "Wallet authorization rejected" : "The wallet request could not be completed" } });
}

export function standardPaymentError(
  error: unknown,
  publicUrl = "https://invalid.local",
): ({ status: number } & ReturnType<typeof standardRailPublicError>) | null {
  const classified = asStandardRailError(error);
  if (!classified) return null;
  return {
    status: classified.status,
    ...standardRailPublicError(classified, publicUrl),
  };
}
export function createStandardRailRouter(service: StandardRailService, publicUrl?: string): Router {
  const router = Router();
  const origin = (publicUrl ?? "https://invalid.local").replace(/\/$/, "");

  router.post("/wallet/orders", async (req, res) => {
    try {
      assertExactKeys(req.body, ["payer", "limit", "cursor", "authorization"]);
      const body = req.body as Record<string, unknown>;
      if (
        typeof body.payer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.payer) ||
        !Number.isSafeInteger(body.limit) || Number(body.limit) < 1 || Number(body.limit) > 100 ||
        !(body.cursor === null || typeof body.cursor === "string")
      ) throw new Error("WALLET_QUERY_INVALID");
      const request = { limit: body.limit, cursor: body.cursor };
      res.setHeader("Cache-Control", "private, no-store");
      if (body.authorization === null) {
        res.json(walletChallengeEnvelope(await service.issueWalletChallenge({
          action: "list-orders", payer: body.payer, request,
          absoluteResourceUri: `${origin}/wallet/orders`,
          clientKey: req.ip ?? req.socket.remoteAddress ?? "unknown",
        })));
        return;
      }
      res.json(await service.listWalletOrders({
        payer: body.payer,
        limit: Number(body.limit),
        cursor: body.cursor as string | null,
        authorization: body.authorization as never,
      }));
    } catch (error) { sendWalletError(res, error); }
  });

  router.post("/wallet/reputation", async (req, res) => {
    try {
      assertExactKeys(req.body, ["payer", "authorization"]);
      const body = req.body as Record<string, unknown>;
      if (typeof body.payer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.payer)) {
        throw new Error("WALLET_QUERY_INVALID");
      }
      const request = {};
      res.setHeader("Cache-Control", "private, no-store");
      if (body.authorization === null) {
        res.json(walletChallengeEnvelope(await service.issueWalletChallenge({
          action: "get-buyer-reputation", payer: body.payer, request,
          absoluteResourceUri: `${origin}/wallet/reputation`,
          clientKey: req.ip ?? req.socket.remoteAddress ?? "unknown",
        })));
        return;
      }
      res.json(await service.getWalletReputation({
        payer: body.payer,
        authorization: body.authorization as never,
      }));
    } catch (error) { sendWalletError(res, error); }
  });

  router.post("/wallet/assets", async (req, res) => {
    try {
      assertExactKeys(req.body, ["payer", "providerAgentId", "limit", "cursor", "authorization"]);
      const body = req.body as Record<string, unknown>;
      if (
        typeof body.payer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.payer) ||
        !(body.providerAgentId === null ||
          (typeof body.providerAgentId === "string" && /^[1-9]\d*$/.test(body.providerAgentId))) ||
        !Number.isSafeInteger(body.limit) || Number(body.limit) < 1 || Number(body.limit) > 100 ||
        !(body.cursor === null || typeof body.cursor === "string") ||
        (body.providerAgentId === null && body.cursor !== null)
      ) throw new Error("WALLET_QUERY_INVALID");
      const request = {
        providerAgentId: body.providerAgentId, limit: body.limit, cursor: body.cursor,
      };
      res.setHeader("Cache-Control", "private, no-store");
      if (body.authorization === null) {
        res.json(walletChallengeEnvelope(await service.issueWalletChallenge({
          action: "list-assets", payer: body.payer, request,
          absoluteResourceUri: `${origin}/wallet/assets`,
          clientKey: req.ip ?? req.socket.remoteAddress ?? "unknown",
        })));
        return;
      }
      res.json(await service.listWalletAssets({
        payer: body.payer,
        providerAgentId: body.providerAgentId as string | null,
        limit: Number(body.limit),
        cursor: body.cursor as string | null,
        authorization: body.authorization as never,
      }));
    } catch (error) { sendWalletError(res, error); }
  });

  router.post("/wallet/assets/action", async (req, res) => {
    try {
      assertExactKeys(req.body, [
        "payer", "providerAgentId", "actionId", "providerAssetId", "input", "authorization",
      ]);
      const body = req.body as Record<string, unknown>;
      if (
        typeof body.payer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.payer) ||
        typeof body.providerAgentId !== "string" || !/^[1-9]\d*$/.test(body.providerAgentId) ||
        typeof body.actionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(body.actionId) ||
        typeof body.providerAssetId !== "string" || !/^[0-9a-f-]{36}$/.test(body.providerAssetId) ||
        !body.input || typeof body.input !== "object" || Array.isArray(body.input)
      ) throw new Error("WALLET_QUERY_INVALID");
      const args = {
        payer: body.payer,
        providerAgentId: body.providerAgentId,
        actionId: body.actionId,
        providerAssetId: body.providerAssetId,
        input: body.input as Record<string, unknown>,
      };
      res.setHeader("Cache-Control", "private, no-store");
      if (body.authorization === null) {
        res.json(walletChallengeEnvelope(await service.issueAssetActionChallenge({
          ...args, absoluteResourceUri: `${origin}/wallet/assets/action`,
          clientKey: req.ip ?? req.socket.remoteAddress ?? "unknown",
        })));
        return;
      }
      res.json(await service.performAssetAction({ ...args, authorization: body.authorization as never }));
    } catch (error) { sendWalletError(res, error); }
  });

  router.get("/.well-known/x402", async (_req, res, next) => {
    try {
      res.json({
        version: 2,
        outcomeSchemaVersion: 1,
        resources: (await service.publicOutcomes()).map((outcome) => ({
          resource: outcome,
          transport: "http",
        })),
        railProfileHash: service.railProfileHash,
      });
    } catch (error) { next(error); }
  });

  router.get("/public/v2/outcomes", async (_req, res, next) => {
    try {
      res.json({
        version: 2,
        outcomeSchemaVersion: 1,
        outcomes: await service.publicOutcomes(),
      });
    }
    catch (error) { next(error); }
  });

  router.get("/public/v2/artifacts/:hash", async (req, res, next) => {
    try {
      const artifact = await service.publicArtifact(String(req.params.hash));
      if (!artifact) {
        res.status(404).json({ error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact not found" } });
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.json(artifact);
    } catch (error) { next(error); }
  });

  router.post("/outcomes/:providerAgentId/:outcomeId", async (req, res, next) => {
    try {
      const providerAgentId = String(req.params.providerAgentId);
      const outcomeId = String(req.params.outcomeId);
      const rawBody = req.body;
      const payerAddress = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) &&
        "payerAddress" in rawBody
        ? (rawBody as Record<string, unknown>).payerAddress
        : undefined;
      if (payerAddress !== undefined &&
          (typeof payerAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(payerAddress))) {
        throw standardRailError("REQUEST_SCHEMA_INVALID", {
          field: "payerAddress",
          fieldErrors: [{
            path: "payerAddress",
            rule: "pattern",
            message: "payerAddress must be a 20-byte EVM address",
          }],
        });
      }
      const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) &&
        "payerAddress" in rawBody
        ? Object.fromEntries(Object.entries(rawBody as Record<string, unknown>)
            .filter(([key]) => key !== "payerAddress"))
        : rawBody;
      const paymentHeader = req.header(PAYMENT_HEADER);
      if (!paymentHeader) {
        const challenge = await service.issueChallenge({
          providerAgentId,
          outcomeId,
          body,
          ...(typeof payerAddress === "string" ? { payerAddress: payerAddress as `0x${string}` } : {}),
        });
        const requiredHeader = encodedPaymentRequiredHeader(
          challenge.paymentRequired as PaymentRequired,
        );
        if (requiredHeader !== null) res.setHeader("PAYMENT-REQUIRED", requiredHeader);
        res.setHeader("DASKI-ORDER-HANDLE", challenge.handle);
        res.setHeader("DASKI-RAIL-PROFILE-HASH", service.railProfileHash);
        if (publicUrl) {
          res.setHeader(
            "DASKI-RAIL-PROFILE",
            `${publicUrl}/public/v2/artifacts/${service.railProfileHash}`,
          );
        }
        res.setHeader("Cache-Control", "private, no-store");
        res.status(402).json(challenge.paymentRequired);
        return;
      }
      const payment: PaymentPayload = decodePaymentHeader(paymentHeader);
      const result = await service.submitPayment({
        providerAgentId, outcomeId, body, payment,
      });
      // A replayed identical authorization answers exactly like the first
      // submission: the same handle, the order's current state, and its
      // receipt when one exists. One reply shape, whichever attempt arrives.
      const receipts = await service.purchaseReceipts(result.order);
      if (receipts.x402PaymentResponse) {
        res.setHeader("PAYMENT-RESPONSE", encoded(receipts.x402PaymentResponse));
      }
      res.setHeader("Cache-Control", "private, no-store");
      const accepted = receipts.receipt !== null && ["DISPATCHED", "FULFILLED", "INPUT_REQUIRED"].includes(result.order.state);
      res.status(accepted ? 200 : 202).json({
        orderHandle: result.handle,
        state: result.order.state,
        receipt: receipts.receipt,
        x402OfferReceipt: receipts.x402OfferReceipt,
      });
    } catch (error) {
      const publicError = standardPaymentError(error, origin);
      if (!publicError) return next(error);
      const { status, ...envelope } = publicError;
      const classified = asStandardRailError(error);
      if (classified) logStandardRailError(classified);
      res.status(status).json({ error: envelope });
    }
  });

  router.post("/orders/:handle/actions/:action", async (req, res, next) => {
    try {
      const action = String(req.params.action);
      if (!ORDER_ACTIONS.includes(action as OrderAction)) {
        res.status(404).json({ error: { code: "ACTION_NOT_FOUND", message: "Unknown action" } });
        return;
      }
      const capabilityHeader = req.header("authorization");
      const capabilityMatch = capabilityHeader?.match(/^DaskiReadCap ([A-Za-z0-9_.-]+)$/);
      const body = req.body as {
        request?: Record<string, unknown>;
        authorization?: Record<string, unknown>;
      };
      if (capabilityMatch) {
        if (action !== "status" && action !== "artifact") {
          throw standardRailError("WALLET_AUTHORIZATION_INVALID");
        }
        assertStandardExactKeys(body, ["request"], "body");
        if (!body.request || typeof body.request !== "object" || Array.isArray(body.request)) {
          throw standardRailError("REQUEST_SCHEMA_INVALID", { field: "request" });
        }
        const result = await service.performAction({
          handle: String(req.params.handle),
          action: action as OrderAction,
          request: body.request,
          readCapability: capabilityMatch[1],
        });
        res.setHeader("Cache-Control", "private, no-store");
        res.json(result);
        return;
      }
      assertStandardExactKeys(body, ["request", "authorization"], "body");
      const authorization = body.authorization;
      if (
        !body.request || typeof body.request !== "object" || Array.isArray(body.request) ||
        !authorization || typeof authorization.orderId !== "string" ||
        typeof authorization.action !== "string" || authorization.method !== "POST" ||
        typeof authorization.absoluteResourceUri !== "string" ||
        typeof authorization.requestHash !== "string" ||
        typeof authorization.nonce !== "string" ||
        typeof authorization.issuedAt !== "number" || typeof authorization.validBefore !== "number" ||
        typeof authorization.signature !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(authorization.requestHash) ||
        !/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce) ||
        !/^0x[0-9a-fA-F]{130}$/.test(authorization.signature) ||
        !Number.isSafeInteger(authorization.issuedAt) ||
        !Number.isSafeInteger(authorization.validBefore)
      ) {
        throw standardRailError("WALLET_AUTHORIZATION_INVALID");
      }
      assertStandardExactKeys(authorization, [
        "orderId", "action", "method", "absoluteResourceUri", "requestHash",
        "nonce", "issuedAt", "validBefore", "signature",
      ], "authorization");
      const result = await service.performAction({
        handle: String(req.params.handle),
        action: action as OrderAction,
        request: body.request,
        authorization: authorization as never,
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json(result);
    } catch (error) {
      const internal = error instanceof Error ? error.message : "ACTION_FAILED";
      const confirmation = CONFIRMATION_HTTP_ERRORS.get(internal);
      if (confirmation) {
        res.status(confirmation.status).json({
          error: {
            code: confirmation.code,
            message: "The confirmation request could not be completed",
          },
        });
        return;
      }
      next(error);
    }
  });

  router.post("/orders/:handle/actions/:action/challenge", async (req, res, next) => {
    try {
      const action = String(req.params.action);
      if (!ORDER_ACTIONS.includes(action as OrderAction)) {
        res.status(404).json({ error: { code: "ACTION_NOT_FOUND", message: "Unknown action" } });
        return;
      }
      assertStandardExactKeys(req.body, ["request"], "body");
      const request = (req.body as { request?: unknown }).request;
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw standardRailError("REQUEST_SCHEMA_INVALID", { field: "request" });
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(await service.issueActionChallenge({
        handle: String(req.params.handle),
        action: action as OrderAction,
        request: request as Record<string, unknown>,
        clientKey: req.ip ?? req.socket.remoteAddress ?? "unknown",
      }));
    } catch (error) { next(error); }
  });

  router.use((
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    if (res.headersSent) return;
    const classified = asStandardRailError(error) ?? standardRailError("INTERNAL_ERROR", {
      internalMessage: error instanceof Error ? error.message : "Unknown standard rail failure",
      cause: error,
    });
    logStandardRailError(classified);
    res.status(classified.status).json({
      error: standardRailPublicError(classified, origin),
    });
  });
  return router;
}
