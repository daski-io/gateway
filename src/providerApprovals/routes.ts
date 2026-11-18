import { Router, type NextFunction, type Request, type Response } from "express";
import { authorizedOperator } from "../serviceRegistration/routes.js";
import {
  parseApprovalRequest,
  ProviderApprovalError,
  providerAgentIdParameter,
  type ProviderApprovalService,
} from "./service.js";

/** How long a public approval answer may be cached: an approval shows within this much of being made. */
export const PUBLIC_APPROVAL_CACHE_CONTROL = "public, max-age=10";

function handler(work: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void work(req, res).catch((error: unknown) => {
      if (error instanceof ProviderApprovalError) {
        res.setHeader("Cache-Control", "no-store");
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      next(error);
    });
  };
}

/**
 * GET /public/v3/providers/:agentId/approval, public; PUT and DELETE
 * /operator/v1/providers/:agentId/approval behind the catalog operator token
 * (docs/provider-approvals.md).
 */
export function createProviderApprovalRouter(args: {
  service: ProviderApprovalService;
  operatorToken: string | null;
}): Router {
  const router = Router();
  router.get("/public/v3/providers/:agentId/approval", handler(async (req, res) => {
    const providerAgentId = providerAgentIdParameter(req.params.agentId);
    const status = await args.service.publicStatus(providerAgentId);
    res.setHeader("Cache-Control", PUBLIC_APPROVAL_CACHE_CONTROL);
    res.json(status);
  }));
  for (const method of ["put", "delete"] as const) {
    router[method]("/operator/v1/providers/:agentId/approval", handler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!authorizedOperator(req, args.operatorToken ?? "")) {
        throw new ProviderApprovalError(401, "OPERATOR_AUTH_REQUIRED", "Operator authentication is required.");
      }
      const providerAgentId = providerAgentIdParameter(req.params.agentId);
      const request = parseApprovalRequest(req.body);
      res.json(method === "put"
        ? await args.service.approveByOperator(providerAgentId, request)
        : await args.service.revokeByOperator(providerAgentId, request));
    }));
  }
  return router;
}
