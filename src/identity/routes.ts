import { Router, type Request, type Response } from "express";
import type { Hex } from "../types.js";
import { logErrorWithId } from "../util/errorWrap.js";
import {
  prepareRegistration,
  submitRegistration,
  type IdentityServiceDeps,
} from "./service.js";

export type IdentityDeps = IdentityServiceDeps;

function isHexAddress(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function badAddress(res: Response): void {
  res.status(400).json({
    error: {
      code: "BAD_ADDRESS",
      message: "address must be a 20-byte hex string",
    },
  });
}

export function createIdentityRouter(deps: IdentityDeps): Router {
  const router = Router();

  router.get(
    "/identity/by-wallet/:address",
    async (req: Request, res: Response) => {
      const raw = String(req.params.address ?? "");
      if (!isHexAddress(raw)) {
        badAddress(res);
        return;
      }
      const address = raw.toLowerCase() as Hex;
      try {
        const agentId = await deps.reader.agentOfWallet(address);
        res.json({
          address,
          agentId: agentId === 0n ? null : agentId.toString(),
        });
      } catch (err) {
        res.status(502).json({
          error: {
            code: "CHAIN_READ_FAILED",
            message: "chain read failed",
            correlationId: logErrorWithId("agentOfWallet", err),
          },
        });
      }
    },
  );

  router.get(
    "/eas/nonce/:address",
    async (req: Request, res: Response) => {
      const raw = String(req.params.address ?? "");
      if (!isHexAddress(raw)) {
        badAddress(res);
        return;
      }
      const address = raw.toLowerCase() as Hex;
      try {
        const nonce = await deps.reader.getEasAttesterNonce(address);
        res.json({ address, nonce: nonce.toString() });
      } catch (err) {
        res.status(502).json({
          error: {
            code: "CHAIN_READ_FAILED",
            message: "chain read failed",
            correlationId: logErrorWithId("easGetNonce", err),
          },
        });
      }
    },
  );

  router.get("/register-prep", async (req: Request, res: Response) => {
    const result = await prepareRegistration(deps, {
      walletAddress: req.query.walletAddress,
      name: req.query.name,
      agentURI: req.query.agentURI,
      deadlineSeconds: req.query.deadlineSeconds,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.value);
  });

  router.post("/register", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await submitRegistration(deps, body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.value);
  });

  return router;
}
