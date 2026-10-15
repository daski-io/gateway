/**
 * The longest a gateway-signed QuoteV1 may be past its validBefore when the
 * gateway signs a new dispatch envelope for its order: 30 days. It bounds the
 * first dispatch, a fresh envelope after a refusal or the provider's no-claim
 * answer, and the first dispatch after an operator redispatch; an order the
 * gateway would dispatch later is held instead (LEGAL_HOLD,
 * first_dispatch_quote_age_exceeded). At exactly this age the envelope is
 * still sent, and its issuedAt is the instant compared. Status polls of an
 * envelope already sent are not bounded.
 *
 * Providers rely on this guarantee to retire quotes: past a quote's
 * validBefore plus this bound, and their own margin, no new claim for it can
 * arrive, so it is no longer an obligation and may be pruned. The provider
 * starters carry the same constant under the same name.
 */
export const MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS = 2_592_000;
