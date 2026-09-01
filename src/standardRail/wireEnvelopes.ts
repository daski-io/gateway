/**
 * The envelopes every wallet and order-action challenge travels in, HTTP and
 * MCP alike — one definition each. Buyers sign what they find under
 * `challenge`; on 2026-09-01 (completion 3) a consumer that expected the sign
 * request one level up refused every live wallet read. The wire fixtures under
 * test/wire-fixtures/ are generated from these helpers and vendored verbatim by
 * the consumers (daski-test, daski-provider); the coordination repo's
 * scripts/pair-fixtures.mjs fails PREP when a vendored copy differs.
 */
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
