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
Recovery creates the signed dispatch with a fresh nonce on its next due tick.
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
envelopes after 10, 20, 40, then 60 seconds, bounded by the listing's
`fulfillmentSeconds` from recorded release evidence (or explicit revival).
A five-minute envelope expiry does not end the fulfillment window. Transport
failures, timeouts and responses without a usable JSON error remain ambiguous;
recovery only polls their existing dispatch hash. Each recovery batch visits an
order at most once, including when a status query leaves its state unchanged.

The default fulfillment deadline is 2,592,000 seconds (30 days). For accepted
orders in `DISPATCHED` or `INPUT_REQUIRED`, deadline evaluation uses the current
listing's `fulfillmentSeconds`, measured from the original dispatch resolution,
even when the checkout snapshot contains the previous 3,600-second default.
Other order terms continue to use the immutable checkout snapshot. A provider
reporting failure still fails through reconciliation immediately; an active
status does not restart the clock.

For listings admitting payer DNS readiness, signed `dns_pending` and
`waiting_capacity` observations suspend that clock. The provider's cumulative
wait duration is monotonic and persisted; repeated reads do not add it again.
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
