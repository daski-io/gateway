import type { RequestHandler } from "express";
import { parseBazaarAuthorization } from "./bazaarAuthorization.js";
import { attributeBazaarPayment } from "./bazaarAttribution.js";
import { resolveBazaarBinding } from "./bazaarBinding.js";
import { ensureExternalSettlement } from "./bazaarExternalSettlement.js";
import {
  prepareBazaarRequest,
  type BazaarDeps,
} from "./bazaarRequest.js";

export type { BazaarDeps } from "./bazaarRequest.js";

export function createBazaarSettlementHandler(
  deps: BazaarDeps,
): RequestHandler {
  return async (req, res) => {
    const request = await prepareBazaarRequest(req, res, deps);
    if (!request) return;
    const authorization = parseBazaarAuthorization(
      request.paymentHeader,
      deps.config,
    );
    if (!authorization.ok) {
      res.status(authorization.status).json({
        x402Version: 2,
        error: authorization.error,
      });
      return;
    }
    const binding = await resolveBazaarBinding(
      res,
      request,
      authorization,
      deps,
    );
    if (!binding) return;
    const external = await ensureExternalSettlement({
      response: res,
      request,
      core: authorization.core,
      from: authorization.from,
      authNonce: authorization.authNonce,
      challenge: binding.challenge,
      quoted: binding.quoted,
      authorizationConsumed: binding.authorizationConsumed,
      buyerAgentId: binding.buyerAgentId,
      deps,
    });
    if (!external) return;
    await attributeBazaarPayment({
      response: res,
      core: authorization.core,
      challenge: external.challenge,
      authorizationConsumed: external.authorizationConsumed,
      from: authorization.from,
      authNonce: authorization.authNonce,
      skillId: request.skillId,
      serviceArgs: request.serviceArgs,
      config: deps.config,
      queries: deps.queries,
      reader: deps.reader,
    });
  };
}
