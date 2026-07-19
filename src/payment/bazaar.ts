import { Router, type Router as ExpressRouter } from "express";
import {
  createBazaarSettlementHandler,
  type BazaarDeps,
} from "./bazaarSettlement.js";

export type { BazaarDeps } from "./bazaarSettlement.js";

export function createBazaarRouter(deps: BazaarDeps): ExpressRouter {
  const router = Router();
  const settlement = createBazaarSettlementHandler(deps);
  router.get("/x402/services/:tokenId/:skillId", settlement);
  router.post("/x402/services/:tokenId/:skillId", settlement);
  return router;
}
