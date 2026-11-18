---
title: "Hosted provider approvals"
status: canonical
authority: current repository implementation
owner: repository maintainers
effective-date: 2026-11-18
last-verified: 2026-11-18 (implementation and tests; no live release verification)
supersedes: none
superseded-by: none
sensitivity: public-safe
related-repositories: daski-io/gateway; daski-io/deploy-mainnet
review-trigger: change to provider control profiles, the catalog's profile selection or hosted admission
---

# Hosted provider approvals

A listing is sold only through a provider control profile: the
`ProviderControlProfileV1` payload that pins the provider's origin, its quote,
dispatch, status, lifecycle and asset URLs, its audience, its response key and
its timeouts. A managed provider's profile is signed and carried in
`STANDARD_RAIL_MANIFEST_JSON`, and the gateway checks its signature once, when
it starts. A hosted provider, one of many sellers served by a hosted provider
runtime under one origin, can instead be **approved by the gateway**: the
gateway builds the profile itself from the provider's registration, stores it
in its database and sells the provider through it. Nothing is signed and no
manifest or variable changes, so an approval needs no restart and has no size
limit.

## Which providers

`HOSTED_PROVIDER_ORIGINS` lists the origins of hosted provider runtimes,
comma-separated bare HTTPS origins such as `https://hosted.example`. Empty or
unset turns approvals off: nothing is approved and the catalog reads no
approval. A registration is hosted when its card's `standardRail.origin` is one
of these origins. The gateway never approves a provider whose registration is
not hosted, and the catalog uses an approval only for a hosted registration.

## The approval record

The record is a `ProviderControlProfileV1` envelope, built once at approval and
stored, so its hash never changes:

- `artifactType` `ProviderControlProfileV1`, `schemaVersion` 1, and the
  `environment`, `chainId` and `audience` this gateway's manifest profiles carry;
- `signerKeyId` `gateway-approval-v1`, `issuedAt` 0, `validBefore` 0 and
  `signature` `0x`: the record is never signed and no key stands behind it;
- `payload.providerAgentId`, `providerAudience`, `origin` and the six URLs are
  the provider's registration and the `standardRail` values of its stored card,
  verbatim (the origin without a trailing slash, as the card check stores it);
- `assetResponseKey` is the registration's agent wallet, checksummed, and
  `assetResponseKeyId` `provider-wallet`;
- `tlsPolicy` `webpki-v1`, `workloadAuthentication` `signed-envelopes-v1`,
  `maxResponseBytes` 524,288 and `timeoutMs` 90,000;
- `servicingProfileEpoch` is one more than the highest epoch any manifest
  profile of the provider carries and any earlier approval record of the
  provider on this chain, else 1. It is chosen under the provider's lock, so an
  epoch never names two different records of a provider.

The payload must pass the rules the start-up check applies to a manifest
profile (`assertProviderControlProfilePayload` in `src/standardRail/artifacts.ts`):
a credential-free HTTPS origin, and URLs on that origin without credentials,
query or fragment. A registration whose card would not pass is not approved.
The record's hash is `canonicalHash(record)` (`src/standardRail/canonical.ts`),
signature included; it is the `providerControlProfileHash` every listing,
quote and dispatch of the provider carries.

Approvals live in `standard_provider_approvals` (migration 063): one row per
approval with `approved_at`, `approved_by` (`invite:<invite id>` or
`operator:<label>`), `revoked_at`, `revoked_by`, `record_json` and
`record_hash`. A provider holds at most one current approval per chain and one
record per epoch; revoking or replacing one sets `revoked_at`, and every row is
kept. A row whose
record no longer hashes to its `record_hash` is never served.

## Approving

**By invite, automatically.** When this gateway activates a hosted
registration, and on a sweep every minute of active hosted registrations, the
gateway reads the hosted runtime's admission report for each provider that
never held an approval on this chain:

    GET <card origin>/p/<agent id>/standard-rail/admission

through the same bounded fetch it uses for provider cards (HTTPS only,
DNS-pinned to public addresses, no redirects, JSON, at most 512 KiB, ten
seconds). It approves when the answer is

```json
{ "providerAgentId": "<agent id>", "chainId": 84532,
  "invite": { "id": "<invite id>", "admissionAuthorized": true,
              "authorizedAt": "<ISO time or null>", "redeemedWallet": "0x…" } }
```

with the provider's own agent id, this gateway's chain, an invite whose
admission is authorized, and a redeeming wallet that is the registration's
provider owner (compared case-insensitively). Other fields are ignored. Any
other answer, or none, leaves the provider unapproved, and a later sweep asks
again: at most 25 providers per sweep, those asked least recently first. One
sweep runs at a time, and it stops when the gateway shuts down. The log records
each outcome with the provider's agent id and a refusal code, never a wallet.

A provider whose approval was revoked is never approved again by invite; only
an operator approves it again.

**By an operator.** Behind `Authorization: Bearer <CATALOG_OPERATOR_TOKEN>`,
with `Cache-Control: no-store`:

- `PUT /operator/v1/providers/:agentId/approval` with
  `{ "reason": "…", "operator": "<label>" }` (`operator` optional, default
  `catalog-operator`) builds the record from the provider's newest active
  hosted registration and approves it. A current approval whose record the
  registration still builds, at its own epoch, is kept (`created: false`); one
  it no longer builds, for example after the provider's wallet moved, is
  revoked and replaced by a record under the next epoch. It answers
  `{ approved: true, approvedAt, record, recordHash, created, inUse }`, where
  `inUse` says whether the catalog sells the provider through this record now
  (see below). A provider without an active hosted registration
  answers 409 `PROVIDER_NOT_HOSTED`; one whose card cannot make a valid record,
  409 with the refusal code.
- `DELETE /operator/v1/providers/:agentId/approval` with `{ "reason": "…" }`
  revokes the current approval and answers
  `{ approved: false, revokedAt, recordHash }`, or 404
  `PROVIDER_APPROVAL_NOT_FOUND`.

`reason` is 1 to 200 printable characters. Each change is recorded with its
reason in `standard_operator_actions` (`operator_provider_approved`,
`operator_provider_approval_revoked`) in the same transaction, the actor being
the label.

## Public status

`GET /public/v3/providers/:agentId/approval` answers
`{ "approved": true, "approvedAt", "record", "recordHash" }` while the catalog
sells the provider through its approval: it holds a current approval,
approvals are on for the record's origin, and neither a current servicing
admission nor a manifest profile names a profile for the provider, which would
come first. Otherwise it answers `{ "approved": false }`, even for a provider
whose approval row exists. Answers carry `Cache-Control: public, max-age=10`
and read the database on every request.
A hosted runtime reads a seller's record here, checks every field is the
seller's own and that `canonicalHash(record)` equals `recordHash`, and then
serves the seller under it. `test/fixtures/provider-approval-answer.json` holds
the answer for a synthetic provider.

## Selling through an approval

The catalog chooses a listing's control profile in this order:

1. the profile the provider's current servicing admission names;
2. a profile the manifest carries for the provider (the one naming the
   registration's agent wallet);
3. only when the manifest carries **no** profile for the provider: its current
   approval record, for a hosted registration on the record's origin.

So a provider sold through a signed profile keeps it, and its hash, whatever
approvals exist. A listing sold through an approval passes the same checks as
any other: the record's `assetResponseKey` must be the registration's agent
wallet and the dispatch deadline at least its timeout. Quotes, intake,
dispatch, dispatch status and lifecycle calls go to the record's URLs, pinned
to its origin and addressed to its audience, under its hash. Approval records,
current or revoked, resolve by hash on `/public/v2/artifacts/:hash` while
approvals are on, as manifest profiles do. A listing retirement for a provider the manifest
carries no profile for is addressed to the audience of its current, else most
recently revoked, approval.

Each process reads current approvals through a snapshot it reuses for 30
seconds; the public catalog's memo lasts 15 seconds. An approval or a
revocation is therefore visible at once in the process that made it and within
about 45 seconds in every other replica. A revocation stops new sales; orders
already paid are dispatched and serviced from the listing stored with them, as
when a profile leaves the manifest. Servicing admissions, asset actions and
owner actions stay with manifest profiles: an approved provider has no asset
actions, as a profile-only provider has none.

## Release

The release capabilities declare `providerApprovals: "database"`
(`scripts/release-capability-input.json`). A release engine that reads it stops
admitting invited hosted providers into the manifest; profiles already in the
manifest stay and keep precedence. An image without the field sells only
providers the manifest carries a profile for, so a rollback past this change
stops sales of providers approved only here until they are admitted again.
Keep `HOSTED_PROVIDER_ORIGINS` set while approved providers sell: unset, they
are not sold.
