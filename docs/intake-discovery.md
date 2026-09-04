# Buyer intake discovery

`daski_get_outcome_requirements` accepts provider and outcome identifiers plus a partial `request` object. REST clients use `POST /outcomes/:providerAgentId/:outcomeId/requirements` with body `{request: {...}}`. Responses use private, no-store caching.

The gateway resolves the current listing, signs `ProviderIntakeRequestV1`, and uses the admitted quote endpoint through the existing pinned provider transport. It verifies the response signature, listing and request hashes, published base schema, response bounds, and expiry. Provider failure returns `PROVIDER_INTAKE_UNAVAILABLE` with a retry action and no possible payment settlement.

The response includes the published `requestSchema`, contextual `requiredFields`, missing `fieldErrors`, required selectors, and normalized selectors. `supported: null` means the provider has not determined availability from those selectors. This operation creates no quote or draft. The completed request still passes through the normal binding quote before approval and payment.

Deployment order: publish buyer 0.3.0, deploy provider intake support and refresh affected service metadata, then deploy the gateway and its new buyer pin. The provider's registered endpoints stay unchanged. A develop push prepares these changes; it does not publish packages or deploy services.
