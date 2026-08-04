import { Router, type Request, type Response } from "express";
import type {
  DaskiPaymentPayload,
  PaymentRequirements,
} from "../types.js";
import type { DaskiFacilitatorService } from "./daskiFacilitator.js";

export interface FacilitatorDeps {
  facilitator: DaskiFacilitatorService;
}

interface FacilitatorBody {
  x402Version?: unknown;
  paymentPayload?: DaskiPaymentPayload;
  paymentRequirements?: PaymentRequirements;
}

export function createFacilitatorRouter(deps: FacilitatorDeps): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/supported", (_req, res) => {
    res.json(deps.facilitator.getSupported());
  });

  router.post("/verify", async (req: Request, res: Response) => {
    const body = validateBody(req.body);
    if (!body.ok) {
      sendBadVerify(res, body.message);
      return;
    }
    res.json(
      await deps.facilitator.verify(
        body.value.paymentPayload,
        body.value.paymentRequirements,
      ),
    );
  });

  router.post("/settle", async (req: Request, res: Response) => {
    const body = validateBody(req.body);
    if (!body.ok) {
      res.status(400).json({
        success: false,
        errorReason: "invalid_request",
        errorMessage: body.message,
        retryable: false,
        transaction: "",
        network: "eip155:0",
      });
      return;
    }
    const result = await deps.facilitator.settleDetailed(
      body.value.paymentPayload,
      body.value.paymentRequirements,
    );
    res.status(result.ok ? 200 : result.status).json(result.response);
  });

  return router;
}

function validateBody(raw: unknown):
  | {
      ok: true;
      value: {
        paymentPayload: DaskiPaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
    }
  | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "request body must be an object" };
  }
  const body = raw as FacilitatorBody;
  const keys = Object.keys(body);
  if (
    keys.some(
      (key) =>
        !["x402Version", "paymentPayload", "paymentRequirements"].includes(key),
    )
  ) {
    return { ok: false, message: "request contains unsupported fields" };
  }
  if (
    body.x402Version !== 2 ||
    body.paymentPayload?.x402Version !== 2 ||
    !body.paymentRequirements
  ) {
    return {
      ok: false,
      message:
        "x402Version, paymentPayload, and paymentRequirements must be V2",
    };
  }
  return {
    ok: true,
    value: {
      paymentPayload: body.paymentPayload,
      paymentRequirements: body.paymentRequirements,
    },
  };
}

function sendBadVerify(res: Response, message: string): void {
  res.status(400).json({
    isValid: false,
    invalidReason: "invalid_request",
    invalidMessage: message,
  });
}
