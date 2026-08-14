import { Router } from "express";
import type { PaymentPayload } from "@x402/core/types";
import { decodePaymentHeader } from "./payment.js";
import type { StandardRailService } from "./service.js";

const PAYMENT_HEADER = "payment-signature";
const UPLOAD_HEADER = "daski-upload-capability";

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

function sendWalletError(
  res: import("express").Response,
  error: unknown,
  fallback = "WALLET_ACCESS_DENIED",
): void {
  const internal = error instanceof Error ? error.message : fallback;
  const code = internal === "WALLET_QUERY_INVALID" ? "WALLET_QUERY_INVALID"
    : internal === "WALLET_RATE_LIMITED" ? "WALLET_RATE_LIMITED"
      : internal === "ASSET_ACTION_NOT_ADMITTED" ? "ASSET_ACTION_NOT_ADMITTED"
        : internal === "ASSET_ACTION_REJECTED" ? "ASSET_ACTION_REJECTED" : fallback;
  const status = code === "WALLET_QUERY_INVALID" ? 400
    : code === "WALLET_RATE_LIMITED" ? 429
      : code.startsWith("ASSET_ACTION_") ? 409 : 401;
  if (status === 429) res.setHeader("Retry-After", "60");
  res.status(status).json({ error: { code, message: code === "WALLET_ACCESS_DENIED"
    ? "Wallet authorization rejected" : "The wallet request could not be completed" } });
}

export function standardPaymentError(error: unknown): {
  status: number;
  code: string;
  message: string;
} | null {
  const internal = error instanceof Error ? error.message : "STANDARD_RAIL_ERROR";
  if (internal === "OUTCOME_NOT_FOUND") {
    return { status: 404, code: "OUTCOME_NOT_FOUND", message: "Outcome not found" };
  }
  if (/malformed|invalid|mismatch|Unsupported|Missing|required|forbidden|differ/i.test(internal)) {
    return {
      status: 400,
      code: "INVALID_STANDARD_PAYMENT",
      message: "The standard payment was rejected",
    };
  }
  return null;
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
        res.json({ authorizationRequired: true, code: "WALLET_AUTHORIZATION_REQUIRED",
          challenge: await service.issueWalletChallenge({
          action: "list-orders", payer: body.payer, request,
          absoluteResourceUri: `${origin}/wallet/orders`,
          clientKey: req.ip ?? req.socket.remoteAddress ?? "unknown",
        }) });
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
        res.json({ authorizationRequired: true, code: "WALLET_AUTHORIZATION_REQUIRED",
          challenge: await service.issueWalletChallenge({
          action: "get-buyer-reputation", payer: body.payer, request,
          absoluteResourceUri: `${origin}/wallet/reputation`,
          clientKey: req.ip ?? req.socket.remoteAddress ?? "unknown",
        }) });
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
        res.json({ authorizationRequired: true, code: "WALLET_AUTHORIZATION_REQUIRED",
          challenge: await service.issueWalletChallenge({
          action: "list-assets", payer: body.payer, request,
          absoluteResourceUri: `${origin}/wallet/assets`,
          clientKey: req.ip ?? req.socket.remoteAddress ?? "unknown",
        }) });
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
        res.json({ authorizationRequired: true, code: "WALLET_AUTHORIZATION_REQUIRED",
          challenge: await service.issueAssetActionChallenge({
          ...args, absoluteResourceUri: `${origin}/wallet/assets/action`,
          clientKey: req.ip ?? req.socket.remoteAddress ?? "unknown",
        }) });
        return;
      }
      res.json(await service.performAssetAction({ ...args, authorization: body.authorization as never }));
    } catch (error) { sendWalletError(res, error); }
  });

  router.post("/uploads/capabilities", async (_req, res, next) => {
    try {
      res.status(201).json(await service.issueUploadCapability());
    } catch (error) { next(error); }
  });

  router.put("/uploads/objects/:objectId", async (req, res, next) => {
    try {
      const capability = req.header(UPLOAD_HEADER);
      const body = req.body as { mediaType?: unknown; contentBase64?: unknown; contentHash?: unknown };
      assertExactKeys(body, ["mediaType", "contentBase64", "contentHash"]);
      if (
        !capability || typeof body.mediaType !== "string" ||
        typeof body.contentBase64 !== "string" || typeof body.contentHash !== "string"
      ) {
        res.status(400).json({ error: { code: "UPLOAD_REQUEST_INVALID", message: "Upload capability and object fields are required" } });
        return;
      }
      res.status(201).json(await service.putUpload({
        capability,
        objectId: req.params.objectId ? String(req.params.objectId) : undefined,
        mediaType: body.mediaType,
        contentBase64: body.contentBase64,
        contentHash: body.contentHash,
      }));
    } catch (error) { next(error); }
  });

  router.delete("/uploads/objects/:objectId", async (req, res, next) => {
    try {
      const capability = req.header(UPLOAD_HEADER);
      if (!capability) {
        res.status(401).json({ error: { code: "UPLOAD_CAPABILITY_REQUIRED", message: "Upload capability required" } });
        return;
      }
      await service.removeUpload(capability, String(req.params.objectId));
      res.status(204).end();
    } catch (error) { next(error); }
  });

  router.get("/.well-known/x402", (_req, res) => {
    res.json({
      version: 2,
      resources: service.listOutcomes().map((outcome) => ({
        resource: outcome,
        transport: "http",
      })),
      railProfileHash: service.railProfileHash,
    });
  });

  router.get("/public/v2/outcomes", async (_req, res, next) => {
    try { res.json({ version: 2, outcomes: await service.publicOutcomes() }); }
    catch (error) { next(error); }
  });

  router.get("/public/v2/artifacts/:hash", (req, res) => {
    const artifact = service.publicArtifact(String(req.params.hash));
    if (!artifact) {
      res.status(404).json({ error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact not found" } });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.json(artifact);
  });

  router.post("/outcomes/:providerAgentId/:outcomeId", async (req, res, next) => {
    try {
      const providerAgentId = String(req.params.providerAgentId);
      const outcomeId = String(req.params.outcomeId);
      const paymentHeader = req.header(PAYMENT_HEADER);
      if (!paymentHeader) {
        const challenge = await service.issueChallenge({
          providerAgentId, outcomeId, body: req.body,
          uploadCapability: req.header(UPLOAD_HEADER),
        });
        res.setHeader("PAYMENT-REQUIRED", encoded(challenge.paymentRequired));
        res.setHeader("DASKI-ORDER-HANDLE", challenge.handle);
        res.setHeader("DASKI-RAIL-PROFILE-HASH", service.railProfileHash);
        if (publicUrl) {
          res.setHeader(
            "DASKI-RAIL-PROFILE",
            `${publicUrl}/public/v2/artifacts/${service.railProfileHash}`,
          );
        }
        res.status(402).json(challenge.paymentRequired);
        return;
      }
      const payment: PaymentPayload = decodePaymentHeader(paymentHeader);
      const result = await service.submitPayment({
        providerAgentId, outcomeId, body: req.body, payment,
        uploadCapability: req.header(UPLOAD_HEADER),
      });
      if (result.replay) {
        res.setHeader("Cache-Control", "private, no-store");
        res.status(200).json({ orderHandle: result.handle });
        return;
      }
      const receipt = await service.signedReceipt(result.order);
      if (receipt) res.setHeader("PAYMENT-RESPONSE", encoded(receipt));
      res.setHeader("Cache-Control", "private, no-store");
      const accepted = receipt !== null && ["DISPATCHED", "FULFILLED", "INPUT_REQUIRED"].includes(result.order.state);
      res.status(accepted ? 200 : 202).json({
        orderHandle: result.handle,
        state: result.order.state,
        receipt,
      });
    } catch (error) {
      const publicError = standardPaymentError(error);
      if (publicError) {
        res.status(publicError.status).json({
          error: { code: publicError.code, message: publicError.message },
        });
        return;
      }
      next(error);
    }
  });

  router.post("/orders/:handle/actions/:action", async (req, res, next) => {
    try {
      const action = String(req.params.action);
      if (!["status", "input", "cancel", "refund", "artifact", "support", "confirmation", "revoke-confirmation",
        "notification-set", "notification-get", "notification-delete"].includes(action)) {
        res.status(404).json({ error: { code: "ACTION_NOT_FOUND", message: "Unknown action" } });
        return;
      }
      const body = req.body as { request?: Record<string, unknown>; authorization?: Record<string, unknown> };
      assertExactKeys(body, ["request", "authorization"]);
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
        res.status(401).json({ error: { code: "ACTION_AUTHORIZATION_REQUIRED", message: "Payer authorization required" } });
        return;
      }
      assertExactKeys(authorization, [
        "orderId", "action", "method", "absoluteResourceUri", "requestHash",
        "nonce", "issuedAt", "validBefore", "signature",
      ]);
      const result = await service.performAction({
        handle: String(req.params.handle),
        action: action as "status" | "input" | "cancel" | "refund" | "artifact" | "support" |
          "confirmation" | "revoke-confirmation" | "notification-set" | "notification-get" | "notification-delete",
        request: body.request,
        authorization: authorization as never,
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : "ACTION_FAILED";
      if (["REPUTATION_NOT_READY", "REPUTATION_UNAVAILABLE",
        "CONFIRMATION_SPONSORSHIP_LIMITED", "CONFIRMATION_SPONSORSHIP_UNAVAILABLE",
        "CONFIRMATION_SUBMISSION_PENDING"].includes(code) || code.includes("SPONSORSHIP_LIMIT")) {
        const publicCode = code.includes("SPONSORSHIP_LIMIT")
          ? "CONFIRMATION_SPONSORSHIP_LIMITED" : code;
        res.status(publicCode === "REPUTATION_NOT_READY" ||
          publicCode === "CONFIRMATION_SUBMISSION_PENDING" ? 409 : 503).json({
          error: { code: publicCode, message: "The confirmation request could not be completed" },
        });
        return;
      }
      if (/NOT_FOUND|AUTHORIZATION/.test(code)) {
        res.status(401).json({
          error: { code: "ORDER_ACCESS_DENIED", message: "Order authorization rejected" },
        });
        return;
      }
      next(error);
    }
  });

  router.post("/orders/:handle/actions/:action/challenge", async (req, res, next) => {
    try {
      const action = String(req.params.action);
      if (!["status", "input", "cancel", "refund", "artifact", "support", "confirmation", "revoke-confirmation",
        "notification-set", "notification-get", "notification-delete"].includes(action)) {
        res.status(404).json({ error: { code: "ACTION_NOT_FOUND", message: "Unknown action" } });
        return;
      }
      assertExactKeys(req.body, ["request"]);
      const request = (req.body as { request?: unknown }).request;
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        res.status(400).json({ error: { code: "ACTION_REQUEST_INVALID", message: "Action request must be an object" } });
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(await service.issueActionChallenge({
        handle: String(req.params.handle),
        action: action as "status" | "input" | "cancel" | "refund" | "artifact" | "support" |
          "confirmation" | "revoke-confirmation" | "notification-set" | "notification-get" | "notification-delete",
        request: request as Record<string, unknown>,
        clientKey: req.ip ?? req.socket.remoteAddress ?? "unknown",
      }));
    } catch (error) { next(error); }
  });

  return router;
}
