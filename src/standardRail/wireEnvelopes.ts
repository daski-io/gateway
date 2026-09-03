/**
 * The envelopes every wallet and order-action challenge travels in, HTTP and
 * MCP alike — one definition each. Buyers sign what they find under
 * `challenge`; on 2026-09-01 (completion 3) a consumer that expected the sign
 * request one level up refused every live wallet read. The wire fixtures under
 * test/wire-fixtures/ are generated from these helpers and vendored verbatim by
 * the consumers (daski-test, daski-provider, daski-buyer); the coordination
 * repo's scripts/pair-fixtures.mjs fails PREP when a vendored copy differs.
 */
import { mcpJson, type McpToolResult } from "../mcp/util.js";
export const WALLET_AUTHORIZATION_REQUIRED = "WALLET_AUTHORIZATION_REQUIRED" as const;
export const ORDER_ACTION_AUTHORIZATION_TYPE = "OrderActionAuthorizationV1" as const;

export function walletChallengeEnvelope<Challenge>(challenge: Challenge) {
  return {
    authorizationRequired: true as const,
    code: WALLET_AUTHORIZATION_REQUIRED,
    challenge,
  };
}

export function orderActionChallengeEnvelope<Challenge>(challenge: Challenge) {
  return {
    authorizationRequired: true as const,
    authorizationType: ORDER_ACTION_AUTHORIZATION_TYPE,
    challenge,
  };
}

/**
 * The `daski_get_payment_challenge` tool result. The challenge is mirrored into
 * `_meta["x402/payment-required"]`, where the x402 MCP transport carries it on
 * the unpaid buy call, so a client reads it from one place on either path; the
 * body keeps the prepare tool's `orderHandle`, `paymentRequired`, and
 * `preflight`. Added 2026-09-03: a client that read `_meta` first and expected
 * a bare challenge failed step one against the nested body.
 */
export function preparedPaymentChallengeResult<Prepared extends { paymentRequired: unknown }>(
  prepared: Prepared,
): McpToolResult {
  return mcpJson(prepared, { "x402/payment-required": prepared.paymentRequired });
}
