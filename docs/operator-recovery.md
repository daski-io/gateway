# Operator recovery

The operator endpoints require `Authorization: Bearer <CATALOG_OPERATOR_TOKEN>`.
They remain available when dynamic service registration is disabled, provided the
token is configured. Responses use `Cache-Control: no-store`. Successful changes
and the actor `catalog-operator` are recorded atomically in
`standard_operator_actions`; tokens are never recorded.

`POST /operator/v1/orders/:orderId/redispatch` requires `PROVIDER_FAILED`, recorded
release evidence, no provider task and no resolved dispatch claim. A live order
driver must finish first. A failed precondition returns HTTP 409 with
`error.reason`; invalid identifiers return 400 and invalid authentication 401.
The action records exactly one `PROVIDER_FAILED` → `RELEASE_FINAL` transition with
reason `operator_redispatch`, archives the previous claim in the audit record and
reserves a new claim ID. It returns `{ orderId, state: "RELEASE_FINAL", claimId }`.
Recovery creates the signed dispatch with a fresh nonce on its next due tick,
within the first-dispatch quote age bound below.
Repeated calls after revival return 409. Failed orders retain their terminal
payment and reputation state. Signed reads can report a separate provider
recovery without redispatching the order.

The same endpoint can revive an existing task when the order is
`PROVIDER_FAILED`, its last transition reason is
`signed_provider_deadline_elapsed`, and the provider's authenticated status for
the recorded task is `working`, `submitted` or `dispatching`. It records exactly
one audited `PROVIDER_FAILED` → `DISPATCHED` transition with reason
`operator_revived` and returns `{ orderId, state: "DISPATCHED" }`. It preserves
the task, dispatch claim and original dispatch resolution time. It sends no new
dispatch and creates no claim. Missing tasks, other failure reasons, other
provider states and unavailable or invalid status responses return 409 with
`error.reason`. These two operator paths are the only exits from
`PROVIDER_FAILED`.

A redispatch without an existing task starts a fresh fulfillment window at the
operator action; the original release evidence is preserved. This lets an already expired order
be retried without immediately failing against its original release deadline.
It does not extend the quote age bound: an order whose quote expired more than
30 days before that tick is held instead of dispatched.

`POST /operator/v1/reputation/:operationId/retry` first reconciles stored
transactions against the chain, then brings pending work forward. A transaction
marked `broadcast` but absent from both transaction and receipt lookups after
one recovery interval is marked failed when its nonce is still available.
An RPC failure is not absence. Recent broadcasts, visible pending transactions,
final transactions and unresolved nonce replacements remain protected.

The retry also accepts `operator_attention` for a finalized nonce conflict,
a missing broadcast, an unsent expired permit, or a `contract_rejection` whose
canonical receipt block proves the registration permit was already expired.
A permit expiring after an unrelated revert does not make that revert retryable.
Legacy failed transactions are checked against their receipt on demand.
The attempt budget is reset for these attention states; the worker prepares
again with the current fee settings and refreshes a near-expired or expired
registration permit while retaining its predecessor hash. It never resends a
persisted registration transaction with an expired permit. A transaction already
visible on chain is reconciled until its receipt resolves it.
The response is `{ operationId, state: "pending" }`; other states or protected
transactions return HTTP 409 with `error.reason`.

`GET /operator/v1/services?hidden=true` lists active registrations disabled by
operator visibility, including unhealthy registrations and visibility inherited
by a replacement registration. Superseded and rejected records are excluded.
It uses the same bearer token and is available with the dynamic registration
route group. `hidden=false` lists enabled registrations. The filter is required.
Optional `limit` is 1–100 (default 50); pass `nextCursor` as `cursor` until null.
The response is `{ services, nextCursor }`; each service includes
`registrationId`, `providerAgentId`, `serviceId`, `serviceSlug`, `serviceVersion`,
`state`, `marketplaceEnabled`, `marketplaceEnabledBy`, and `marketplaceEnabledAt`.
Use the returned registration ID with the existing visibility PUT to restore it.
This inventory does not attribute hides to a particular maintenance run; a
coordinator should still persist which registrations that run changed.

Provider dispatch refusals containing a JSON `error` are recorded with their HTTP
status, reason and signed envelope. Recovery retries with fresh nonces and
envelopes after 10, 20, 40, then 60 seconds, bounded by the checkout snapshot's
`fulfillmentSeconds` from the first recorded release-evidence observation (or
explicit revival). This initial dispatch window is separate from the fulfillment
deadline below and does not use a recorded longer duration. A five-minute
envelope expiry does not end the window, so a timely-paid order is still
dispatched, with a fresh envelope, days after its quote expired, up to the
quote age bound below. Transport
failures, timeouts and responses without a usable JSON error remain ambiguous;
recovery only polls their existing dispatch hash. Once that envelope has expired
(its `validBefore` plus 60 seconds), a status answer of 404 with a JSON `error`
and reason `outcome_policy` means the provider holds no claim for it and never
accepted it (the provider answers the same 404 for a bad signature, clock skew
and its own internal errors, reason `validator`, which keep the order polling): recovery records
it as a refusal (HTTP status 404, reason `{ source: "dispatch_status", error,
reason }`) and retries with a fresh envelope like any refusal. The provider keeps
at most one task per order. Before expiry, or on any other status answer, recovery
keeps polling. Each recovery batch visits an
order at most once, including when a status query leaves its state unchanged.

No new dispatch envelope is signed for an order more than 2,592,000 seconds
(30 days, `MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS`) after its quote's
`validBefore`: not the first dispatch, a fresh envelope after a refusal or a
no-claim answer, nor the first dispatch after an operator redispatch. The
gateway then signs, records and sends nothing, and moves the order from
`RELEASE_FINAL`, `DISPATCH_STARTED` or `DISPATCH_AMBIGUOUS` to `LEGAL_HOLD` with
reason `first_dispatch_quote_age_exceeded`. At exactly 30 days the envelope is still
sent; its `issuedAt` is the instant compared, so a provider that applies the
same bound to the quote a dispatch carries never refuses one the gateway sends.
Status polls of an envelope already sent continue past the bound. Providers
rely on this guarantee to stop treating a quote as an obligation, and to prune
it, once the bound and their own margin have passed. `LEGAL_HOLD` has no exit,
so the redispatch endpoint does not apply to such an order. Its release is
proven, so it does not stop the listing's other purchases settling; they wait
only for a hold that never proved its release.

The default fulfillment deadline is 2,592,000 seconds (30 days). An accepted
order in `DISPATCHED` or `INPUT_REQUIRED` fails at its original dispatch
resolution plus its effective fulfillment duration plus any admitted wait
below. The effective duration is the longest of the checkout snapshot's
`fulfillmentSeconds`, a longer duration already recorded for the order
(`standard_orders.effective_fulfillment_seconds`), and the listing that services
it now: the service's current version of the outcome, and the order's own
version while a registration retains it, read from stored registrations
whether or not sales are open, the service is visible or its card is fresh. A
longer current duration is recorded, under the order's version and lease
fence, before the deadline relies on it; a shorter later listing, a missing
listing, a failed catalog lookup or a restart therefore never shortens the
deadline or stops it being enforced. An order placed under the former
3,600-second default gains the 30-day default when its own or its service's
current version is read, and keeps it from then on. Orders that predate the
recorded duration start from their snapshot; no unrecorded extension is assumed. A
database failure delays an evaluation without moving its origin. Other order
terms continue to use the immutable checkout snapshot. A provider reporting
failure still fails through reconciliation immediately; an active status does
not restart the clock. While dispatch status gives no authenticated answer, a
signed completion the gateway already stored for the order's task fulfills the
order on the next recovery pass with reason `stored_provider_completion`, so an
outage does not fail work the provider proved complete. Any answer the provider
does give decides instead: one that contradicts the stored evidence is rejected
and leaves the order open, as does an active status. A stored failure waits for
the deadline.

An expired deadline records `PROVIDER_FAILED` with reason
`signed_provider_deadline_elapsed`. It neither cancels nor refunds the
provider's task, and nothing revives the order automatically. Authorized status
and artifact reads keep working: a task the provider completes later returns its
artifact with `fulfillmentState: "completed"` while `orderState` stays
`PROVIDER_FAILED` and the signed payment receipt is unchanged. Only the operator
revival above returns such an order to `DISPATCHED`; it keeps the original
dispatch resolution and recorded duration, so the order fails again unless a
longer duration has become available.

For listings admitting payer DNS readiness, signed `dns_pending` and
`waiting_capacity` observations suspend that clock. The provider's cumulative
wait duration is monotonic and persisted; repeated reads do not add it again.
Concurrent reads may arrive out of order: an older signed observation is
ignored rather than failing the request, while two different views under one
revision are rejected as equivocation.
Missing or stale rechecks create `provider_wait_progress_stale` incidents and
leave the obligation pending. Waits do not consume new-payment execution capacity.

Provider recovery is authorized through the provider Review controls. The gateway
does not acknowledge or authorize supplier work. It validates `operations.recovery`
against the original signed failed terminal result, preserving that attestation
and the order's original `PROVIDER_FAILED` state. Authorized status/artifact reads
refresh this projection; the background worker refreshes failures with observed
open support or unfinished recovery at most every five minutes. A new recovery
that the gateway has never observed is discovered on the next authorized read.
`fulfillmentState: "recovered"` is operational fulfillment, not a reputation rewrite.
