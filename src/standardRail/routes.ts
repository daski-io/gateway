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

export function createStandardRailRouter(service: StandardRailService, publicUrl?: string): Router {
  const router = Router();

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

  router.get("/public/v2/outcomes", (_req, res) => {
    res.json({ version: 2, outcomes: service.listOutcomes() });
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
      const accepted = receipt !== null && ["DISPATCHED", "FULFILLED", "KYC_REQUIRED"].includes(result.order.state);
      res.status(accepted ? 200 : 202).json({
        orderHandle: result.handle,
        state: result.order.state,
        receipt,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "STANDARD_RAIL_ERROR";
      if (code === "OUTCOME_NOT_FOUND") {
        res.status(404).json({ error: { code, message: "Outcome not found" } });
        return;
      }
      if (/malformed|invalid|mismatch|Unsupported|Missing|required|forbidden|differ/i.test(code)) {
        res.status(400).json({ error: { code: "INVALID_STANDARD_PAYMENT", message: code } });
        return;
      }
      next(error);
    }
  });

  router.post("/orders/:handle/actions/:action", async (req, res, next) => {
    try {
      const action = String(req.params.action);
      if (!["status", "input", "cancel", "refund", "artifact", "support"].includes(action)) {
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
        action: action as "status" | "input" | "cancel" | "refund" | "artifact" | "support",
        request: body.request,
        authorization: authorization as never,
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : "ACTION_FAILED";
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
      if (!["status", "input", "cancel", "refund", "artifact", "support"].includes(action)) {
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
        action: action as "status" | "input" | "cancel" | "refund" | "artifact" | "support",
        request: request as Record<string, unknown>,
      }));
    } catch (error) { next(error); }
  });

  return router;
}
