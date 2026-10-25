# Runtime release controls

A gateway image carries executable capability; installing it does not advance a
paid contract or asset-action epoch. The configured deployment healthcheck stays
`/health/live`. It returns 200 only after migrations, signed manifest validation,
all database-current servicing admissions, visible paid listing compilation and
the captured commerce baseline have passed local checks. Provider, supplier,
facilitator and RPC probes run in the background. Their current availability is
reported separately by `/health/ready`.

The candidate starts registration refresh and external-effect workers only after
local readiness succeeds. Existing shutdown drains HTTP and worker work before
closing pools. Claim leases, authorization groups, dispatch claims, signed
transactions and review/reputation journals retain their existing formats.

## Capability and baseline

`GET /internal/release/v1/capabilities` requires the catalog operator bearer
token. It reports the immutable build commit and
`artifactManifestHash: "sha256:<hex>"` of the exact embedded
`dist/release-capabilities.json` bytes, plus Railway's `deploymentId` and
`network: "eip155:<chainId>"`.

The artifact declares protocol and worker formats. Its empty `paidContracts`
array is not wildcard proof: the gateway compiles dynamically registered
contracts. Runtime `runtimeMappings` (also `executableListings`) names the exact
listing and skill hashes actually compiled on that instance.
`carriedAdmissions` names all locally carried signed admission bundles;
`currentAdmissions` names only database-current admissions. A coordinator must
bind prospective contract qualification to the exact image digest and contract
hash, and sample every potentially serving deployment.

`DASKI_COMMERCE_BASELINE_JSON` is a versioned gateway snapshot with
`schemaVersion:1`, `role:"gateway"`, `network`, `observedAt`,
`sources:[{deploymentId,digest}]`, and
`offered:[{serviceId,serviceSlug,skillId,skillContractHash,listingManifestHash,localPrerequisites}]`.
Prerequisites are environment variable names, never secret values. Readiness
checks local support and prerequisite presence; observation age and transient
provider availability do not expire a baseline.

## Registration revision fences

`POST /internal/release/v1/registration-fences` accepts the existing signed
`ProviderServiceRegistrationIntentV1` envelope with positive safe-integer
`payload.targetRevision`. The provider signature, finalized authority, service,
environment, chain, audience and validity window authorize this narrowly scoped
write; an operator token is not needed. An exact committed replay is acknowledged
without requiring the original envelope to remain unexpired.

The database commits the revision and withdraws lower pending registrations
atomically. Triggers constrain overlapping older writers too. Shared guard-row
writes force stale SERIALIZABLE transactions to retry instead of admitting from
a snapshot older than the fence. Missing revision remains signed legacy zero.
A fence acknowledgment prevents stale activation; it does not claim the desired
successor is already active.

`GET /internal/release/v1/registration-fences?providerAgentId=...&serviceId=...`
requires the catalog operator bearer token and returns the committed revision.

## Asset-action targets

Authenticated `POST /internal/release/v1/asset-action-target` accepts
`{requestId,providerAgentId,expectedEpoch,targetEpoch}`. The target is durable,
monotonic and idempotent. All contiguous signed admissions through the desired
epoch must be carried. The background transaction advances current admission
only after local readiness; a broken chain rolls back the entire advance.
GET on the same path with `providerAgentId` reports desired/current epoch,
current admission hash and ACTIVE/PENDING status. A higher pre-signed revert
epoch is a forward transition.

`STANDARD_RAIL_ASSET_ACTION_TARGET_EPOCHS_JSON` is accepted as a legacy
configuration map. It is not an activation command and cannot overwrite the
durable target or lower database state. An installation bootstraps to the current
admission (or initial profile), even if future bundles are carried.

Multiple historical/current/future profiles may be carried. The same immutable
action definition may appear in multiple catalogs; changing a definition under
the same action identity is refused. An accepted action resumes against the
admission in its durable claim after a later revert. An unaccepted old wallet
authorization cannot bypass the current admission.

## Scoped stop-sale

Authenticated `POST /internal/release/v1/sales` accepts
`{requestId,expectedRevision,providerAgentId,serviceId,listingManifestHash,acceptingNewOrders}`.
The exact tuple must resolve to persisted registration or order facts. Revisions
are independent of registration and asset-action revisions. GET with the three
scope fields reports `revision`, `requestId` and `acceptingNewOrders`.

A stop blocks fresh/reused challenges, new authorization admission and the
atomic settlement-invocation journal boundary. Captured, never-invoked
authorizations are durably parked without dropping their original order,
signature or payer hold. Resuming sales does not silently submit those parked
authorizations. Work already paid or whose submission was admitted remains
recoverable under its original contract.

The current runtime claims a payment at READ COMMITTED. The stop lock is taken
before the sale controls are read, so a claim that waited behind a stop reads
it and is refused, and a stop that waited behind a claim parks the
authorization that claim committed; the retirement guard row orders claims and
retirement the same way. The guard-row writes remain for an overlapping prior
runtime, whose SERIALIZABLE claim fails when its snapshot predates a stop or
retirement. Such a prior-runtime claim also counts open-order capacity from its
snapshot, which misses a reservation a current-runtime claim of the same
listing committed after that snapshot was taken: during an overlap, such
racing claims can admit more open orders than the listing's capacity.

Stopped status separates gateway submission from payment observation. It reports
the finalized block/nonce observation and authorization expiry when available.
Absence of a payment observation is not proof of unpaid status. Cancellation or
expiry with an unused nonce at a finalized block is required before terminal
unpaid state; a used nonce alone does not prove payment or cancellation.
An externally relayed matching payment follows the original bound recovery path.

## Sales outage

One switch per environment stops every new sale at the gateway for a short,
bounded time, for planned changes such as a provider identity switch. The
gateway's database serves one environment, so `standard_sales_outage` holds one
preseeded row (`active`, `reason`, `since`, `until`, `set_by`, `revision`);
`standard_sales_outage_audit` records every start, extension and end.

Operator endpoints take the catalog operator bearer token and answer
`Cache-Control: no-store`:

- `POST /internal/release/v1/sales-outage` with `{"minutes":10,"reason":"...","setBy":"..."}`
  starts an outage. `minutes` is an integer from 1 to 60 and defaults to 10;
  `reason` (1 to 200 printable characters) is required and shown publicly;
  `setBy` is optional (default `catalog-operator`). Starting while an outage is
  active extends its end to now plus `minutes` when that is later; it never
  shortens it and keeps `since`. Anything else answers 400
  `INVALID_SALES_OUTAGE_REQUEST`.
- `DELETE /internal/release/v1/sales-outage` (optional `{"setBy":"..."}`) ends an
  active outage now. Ending an inactive or expired one changes nothing.
- `GET /internal/release/v1/sales-outage` reads it.

Each answers the public status below plus `setBy` while active and the row's
`revision`. Every change is logged (`sales outage started`, `extended`,
`ended`) and audited. A start or end takes the row lock, so it waits for
admissions that hold it; under steady admissions it can time out with a 500,
and the caller retries.

`GET /public/v1/status` is unauthenticated and answers `{"salesOpen":true}` or
`{"salesOpen":false,"reason":"...","since":"<ISO 8601>","until":"<ISO 8601>"}`
with `Cache-Control: max-age=5`. Like liveness it is not charged to a rate-limit
bucket: each replica serves every caller from one database read a second, a
failed read included. Any answer other than 200 with this shape (a 500, or 503
`SHUTTING_DOWN` during a shutdown) means the state is unknown. The website and
its MCP read it. `/health/ready` reports the same object as `sales` (with
`setBy` and `revision` for the operator token); an outage never makes
readiness fail.

An outage ends by itself when `until` passes: nothing runs at expiry and every
reader compares `until` with the database clock. While it is active the
gateway answers HTTP 503 `SALES_PAUSED` with `Retry-After` (seconds until
`until`, at most 3,600), and the error carries `until` and `reason`, for:

- new quotes and payment challenges;
- purchases: a signed submission that has not yet claimed its authorization
  (replays of a claimed submission and conflicting authorizations keep their
  usual answers);
- settlement of an authorization that was claimed but not yet submitted, on
  the request path, where the database refuses the invocation and the error
  carries `paymentMayHaveSettled: true` and `requiresNewSignature: false`
  (the claimed authorization is submitted after the outage while it is
  valid, so the buyer reconciles and never signs again), and in recovery,
  which leaves it as it is and keeps looking for a deposit relayed meanwhile.

The database enforces it too: `standard_assert_sale_open()`, which every
admission and settlement-invocation trigger calls, locks the outage row and
raises `SALE_SUSPENDED` with detail `SALES_PAUSED`. An overlapping prior
runtime therefore refuses a claim (its existing `SALE_SUSPENDED` answer) and
leaves a settlement unsubmitted during a deploy. The row lock orders a start
with admissions: a start waits for an admission that locked first, an
admission that waited behind a start reads it, and a REPEATABLE READ or
SERIALIZABLE snapshot older than the start fails and retries. A settlement
invocation admitted before the start commits before its facilitator call, so
such a deposit can still land seconds after the start returns; a cutover
waits a few seconds after starting the outage. Migration 062 grants the
incumbent runtime role what it needs before the candidate configures runtime
privileges: SELECT on the outage row and UPDATE on its key column only, which
FOR SHARE requires and which cannot change the outage.

Work already paid continues: deposit and release proofs, reputation permits
and registration, dispatch, lifecycle, receipts, order actions and reviews are
not gated, so no paid order reaches `LEGAL_HOLD` or a deadline because of an
outage. Replays of an already claimed submission still answer its order.

## Provider authority switches

A listing version commits the provider agent's wallet it was registered with
(`providerAuthorityKey`, `providerTerminalAttestationKey`). When a provider
authority switch moves the agent wallet in IdentityRegistry, the provider signs
every order with its new wallet, old versions' orders included. For an
existing order the gateway accepts a lifecycle response, a dispatch response or
a terminal attestation signed by the committed key without a chain read, and
any other signer only when it is the listing's provider agent's current
`getAgentWallet`, read at the configured finality tag and cached for a minute.
Every other key is refused as before. Quotes and intake stay bound to the
committed key, so a version registered before the switch never sells under the
new wallet. When the wallet cannot be read, an order action answers the
retryable `PROVIDER_LIFECYCLE_UNAVAILABLE` (a read capability is reused) and a
dispatch stays ambiguous for recovery. The first acceptance per agent, signer
and committed key is logged.

The gateway sees a switch only once `setAgentWallet` is final at its finality
tag, plus up to a minute of cache. Until then an action on an old order that
the provider signed with the new wallet answers 500 `INTERNAL_ERROR` (logged as
`PROVIDER_LIFECYCLE_SIGNATURE_INVALID`); a sales outage does not cover this,
since order actions are not gated. A quote signed with the new wallet never
passes for a version committing the old one. A switch therefore keeps the
provider signing with the committed key until the gateway's finality tag holds
the new wallet and versions committing it are live.

## Compatibility evidence

The PostgreSQL tests exercise incumbent restricted-role writes before candidate
runtime setup and SERIALIZABLE stop/fence races. Startup proof uses the compiled
application on pre-existing state, preserves current admissions during capability
installation, and checks explicit target advancement. The prior-runtime script
boots the exact requested baseline source revision on candidate migrations.

These local proofs do not certify a production deployment platform or every
baseline image's worker handover. The release coordinator must retain its
recorded compatible baseline until exact-artifact overlap, failure and restore
evidence covers the serving fleet. No healthcheck or CI label substitutes for
that deployment evidence.
