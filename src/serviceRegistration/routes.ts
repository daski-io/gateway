import { timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Hex } from "viem";
import type { Config } from "../config.js";
import {
  RegistrationError,
  type ServiceRegistrationService,
} from "./service.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICE_ID = /^0x[0-9a-fA-F]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

function handler(
  work: (req: Request, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void work(req, res).catch((error: unknown) => {
      if (error instanceof RegistrationError) {
        if (error.status === 429) res.setHeader("Retry-After", "10");
        res.status(error.status).json({
          error: { code: error.code, message: error.message },
        });
        return;
      }
      next(error);
    });
  };
}

function registrationId(req: Request): string {
  const value = req.params.registrationId;
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new RegistrationError(
      400,
      "INVALID_REGISTRATION_ID",
      "registrationId must be a UUIDv4.",
    );
  }
  return value.toLowerCase();
}

function authorizedOperator(req: Request, expected: string): boolean {
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice(7), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function pageLimit(raw: unknown): number {
  if (raw === undefined) return 50;
  if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw)) {
    throw new RegistrationError(400, "INVALID_LIMIT", "limit must be an integer from 1 to 100.");
  }
  const value = Number(raw);
  if (value < 1 || value > 100) {
    throw new RegistrationError(400, "INVALID_LIMIT", "limit must be an integer from 1 to 100.");
  }
  return value;
}

export function createServiceRegistrationRouter(args: {
  config: Config;
  service: ServiceRegistrationService;
}): Router {
  if (!args.config.dynamicServiceRegistrationEnabled) {
    throw new Error("Dynamic service registration router cannot be mounted while disabled");
  }
  const operatorToken = args.config.catalogOperatorToken;
  if (!operatorToken) throw new Error("Catalog operator token is required");
  const router = Router();

  router.get("/public/v3/registration-policy", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(args.service.policy());
  });

  router.post("/v1/service-registrations", handler(async (req, res) => {
    const idempotencyKey = req.header("idempotency-key");
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new RegistrationError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency-Key must be 8-128 URL-safe characters.",
      );
    }
    const result = await args.service.register(req.body, idempotencyKey);
    res
      .status(result.created ? 201 : 200)
      .location(`/v1/service-registrations/${result.registration.registrationId}`)
      .json(result.registration);
  }));

  router.get("/v1/service-registrations/:registrationId", handler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await args.service.get(registrationId(req)));
  }));

  router.post(
    "/v1/service-registrations/:registrationId/evidence",
    handler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await args.service.submitEvidence(registrationId(req), req.body));
    }),
  );

  router.get("/public/v3/services", handler(async (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json(await args.service.listPublic(pageLimit(req.query.limit)));
  }));

  router.get("/public/v3/services/:serviceId", handler(async (req, res) => {
    const serviceId = req.params.serviceId;
    if (typeof serviceId !== "string" || !SERVICE_ID.test(serviceId)) {
      throw new RegistrationError(
        400,
        "INVALID_SERVICE_ID",
        "serviceId must be bytes32.",
      );
    }
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json(await args.service.getPublic(serviceId.toLowerCase() as Hex));
  }));

  // Signed admission artifacts (intents, preparations, control profiles) by
  // content hash, so a runtime commitment's references resolve publicly.
  router.get("/public/v3/artifacts/:hash", handler(async (req, res) => {
    const hash = req.params.hash;
    if (typeof hash !== "string" || !SERVICE_ID.test(hash)) {
      throw new RegistrationError(400, "INVALID_ARTIFACT_HASH", "hash must be bytes32.");
    }
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.json(await args.service.publicArtifact(hash.toLowerCase() as Hex));
  }));

  router.put(
    "/operator/v1/services/:registrationId/visibility",
    handler(async (req, res) => {
      if (!authorizedOperator(req, operatorToken)) {
        throw new RegistrationError(
          401,
          "OPERATOR_AUTH_REQUIRED",
          "Operator authentication is required.",
        );
      }
      if (
        !req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 ||
        typeof (req.body as { visible?: unknown }).visible !== "boolean"
      ) {
        throw new RegistrationError(
          400,
          "INVALID_VISIBILITY_UPDATE",
          "The body must be exactly { visible: boolean }.",
        );
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(await args.service.setVisibility(
        registrationId(req),
        (req.body as { visible: boolean }).visible,
      ));
    }),
  );

  return router;
}
