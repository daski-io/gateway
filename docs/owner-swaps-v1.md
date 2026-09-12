# Provider owner swaps v1

A provider that has changed which wallet owns one of its assets tells the
gateway with one signed notice. The gateway records the notice and adds
gateway eligibility for the new payer with that provider: owner-only asset
reads (`daski_list_assets`) and actions (`daski_use_asset`) for the
provider's assets. Nothing else changes: no order, receipt, claim, nonce
ledger, or reputation row is rewritten, and the previous payer keeps the
order's lifecycle and confirmation rights. The provider's own ledger remains
the sole authority over which wallet owns which asset; the gateway only
mirrors the eligibility the provider granted.

The route is off by default (`OWNER_SWAPS_ENABLED=false`) and budgeted per
provider per day (`OWNER_SWAPS_PER_PROVIDER_PER_DAY`, 50; first acceptances
only). Requests join the `service-registration` rate-limit groups.

## Resource

`POST /v1/owner-swaps` with an `Idempotency-Key` header of 8 to 128
URL-safe characters and a `ProviderOwnerSwapV1` envelope as the body.

Responses:

| Status | Meaning |
|---|---|
| 201 | First acceptance; body is the persisted record. |
| 200 | Replay: the same `(providerAgentId, providerAssetId, ownerVersion)` with an equal content hash, whatever the envelope's age or signing key. |
| 400 | `OWNER_SWAP_INVALID` (payload format), `INVALID_IDEMPOTENCY_KEY`. |
| 401 | `OWNER_SWAP_AUTH_INVALID`: window, audience, environment, chain, keys, or a signer that is not the provider's current finalized owner or agent wallet. |
| 403 | `OWNER_SWAPS_DISABLED`, `NEW_PAYER_SANCTIONED`. |
| 404 | `ORDER_NOT_FOUND`. |
| 409 | `ORDER_PROVIDER_MISMATCH`, `ORDER_KEY_MISMATCH`, `OWNER_SWAP_CONFLICT` (same key, different content hash). |
| 429 | `OWNER_SWAP_RATE_LIMITED` (the provider's daily budget). |
| 503 | `SCREENING_UNAVAILABLE` (the sanctions oracle could not be read; retry). |

The record:

```json
{
  "providerAssetId": "5e0f95a6-3f9f-4bb0-9a68-59f2e26bde33",
  "ownerVersion": 1,
  "newPayer": "0x2222222222222222222222222222222222222222",
  "contentHash": "0x364b0b9881c7ab6da1ed0f0991dc3bf903d5bbe9614103b4c79e745ffdb89af6",
  "receivedAt": "2026-09-11T12:00:00.000Z"
}
```

## Envelope

The closed `SignedEnvelope` used by service registration
([service-registration-v1.md](service-registration-v1.md)): `artifactType`
`ProviderOwnerSwapV1`, `schemaVersion` 1, the gateway's `environment` and
`chainId`, `audience` equal to the gateway's public URL, `signerKeyId`
`provider-authority`, `issuedAt`, `validBefore` at most ten minutes after
`issuedAt`, the payload, and a 65-byte personal signature over the
canonical artifact-payload hash by the provider's current finalized owner
or agent wallet, read live from `ProviderRegistry` and ERC-8004.

Payload fields, all required, none other:

| Field | Rule |
|---|---|
| `providerAgentId` | decimal string; must equal the signing provider |
| `providerAssetId` | lowercase UUID; opaque to the gateway |
| `ownerVersion` | positive integer; the provider's override version for this asset |
| `orderId` | the gateway `ord_…` id the provider holds as `standard_order_id` |
| `orderKey` | bytes32; equals `keccak256(orderId)` and the stored order key |
| `previousPayer` | lowercase address; informational |
| `newPayer` | lowercase address; not equal to `previousPayer` |

Content hash: `keccak256` of the canonical (RFC 8785 style, sorted keys)
JSON of the payload. `issuedAt` and `validBefore` are envelope fields, so
re-signing the same payload later produces the same content hash: a retry
after an outage longer than the envelope's validity, or after the provider
rotated its authority key, is answered with the persisted record.

Checks, all fail closed: exact keys and formats; validity window, audience,
environment, and chain; the order exists; `order.providerAgentId` equals
`providerAgentId`; `order.orderKey` equals `orderKey`; `newPayer` passes the
sanctions oracle (an unreadable oracle is 503, retryable).

## Effect

One row in `standard_provider_owner_swaps`, keyed by
`(provider_agent_id, provider_asset_id, owner_version)`, carrying the
order id, both payers, the content hash, the canonical envelope, the signer,
and the receipt time. Eligibility for wallet actions and asset federation
becomes: a post-deposit order by the payer with the provider, OR a swap row
with `new_payer = payer` and `provider_agent_id = providerAgentId`. A
provider can therefore grant eligibility only for its own assets, anchored
to one of its own orders.

## Golden vector

`test/vectors/managed-marketplace-v1.json` (`ownerSwap`) pins the sample
below, signed by a public development key
(`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`); consumers can check their
canonicalization against it.

```json
{
  "artifactType": "ProviderOwnerSwapV1",
  "schemaVersion": 1,
  "environment": "testnet",
  "chainId": 84532,
  "audience": "https://sandbox-gateway.daski.io",
  "signerKeyId": "provider-authority",
  "issuedAt": 1756769000,
  "validBefore": 1756769600,
  "payload": {
    "providerAgentId": "42",
    "providerAssetId": "5e0f95a6-3f9f-4bb0-9a68-59f2e26bde33",
    "ownerVersion": 1,
    "orderId": "ord_12345678-1234-4123-8123-123456789abc",
    "orderKey": "0xe664d7ca5d2ad0ca8774a3e5f0f77174f4926b3c534344d8792ac298cc4ca0d6",
    "previousPayer": "0x1111111111111111111111111111111111111111",
    "newPayer": "0x2222222222222222222222222222222222222222"
  },
  "signature": "0xc8333bcc5da212da22c2520db35c6090510cc12a722a6e4ec7529a9195484a5e2e072cac3a4e5e9ac0e6dc9c42e3ae1a0c2eb824dc8563324862ad9e1befb5011b"
}
```

- `artifactPayloadHash`: `0xf72a6cc690701e424a1c8f89ceb6ce290cbe923fcc8dfcdc18cee2b781c570ad`
- `contentHash`: `0x364b0b9881c7ab6da1ed0f0991dc3bf903d5bbe9614103b4c79e745ffdb89af6`
