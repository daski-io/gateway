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

Stopped status separates gateway submission from payment observation. It reports
the finalized block/nonce observation and authorization expiry when available.
Absence of a payment observation is not proof of unpaid status. Cancellation or
expiry with an unused nonce at a finalized block is required before terminal
unpaid state; a used nonce alone does not prove payment or cancellation.
An externally relayed matching payment follows the original bound recovery path.

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
