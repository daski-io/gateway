import { Router, type Request, type Response } from "express";
import {
  prepareConfirmation,
  type ConfirmationPrepDeps,
} from "./confirmationPrep.js";

export type PrepDeps = ConfirmationPrepDeps;

export function createPrepRouter(deps: PrepDeps): Router {
  const router = Router();
  router.get(
    "/confirm-prep/:paymentId",
    async (req: Request, res: Response) => {
      const result = await prepareConfirmation(deps, {
        paymentId: req.params.paymentId,
        confirmation: req.query.confirmation,
        attester: req.query.attester,
        deadlineSeconds: req.query.deadlineSeconds,
        refUid: req.query.refUid,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json(result.value);
    },
  );
  return router;
}
