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
Repeated calls after revival return 409. Other exits from `PROVIDER_FAILED`
remain closed, and failed orders remain terminal for automatic recovery.

An explicit revival starts a fresh fulfillment window at the operator action;
the original release evidence is preserved. This lets an already expired order
be retried without immediately failing against its original release deadline.

`POST /operator/v1/reputation/:operationId/retry` brings a pending operation's
`next_attempt_at` forward to now. It also accepts `operator_attention` with
`last_error_class=nonce_conflict`: the worker has already established that the
nonce was consumed at finality with no receipt for the original transaction.
Any remaining prepared transaction is marked failed, the attempt budget is reset,
and the worker prepares a new transaction on its next tick. Broadcast/final
transactions and other operation states return 409 with `error.reason`.
The response is `{ operationId, state: "pending" }`.

Provider dispatch refusals containing a JSON `error` are recorded with their HTTP
status, reason and signed envelope. Recovery retries with fresh nonces and
envelopes after 10, 20, 40, then 60 seconds, bounded by the listing's
`fulfillmentSeconds` from recorded release evidence (or explicit revival).
A five-minute envelope expiry does not end the fulfillment window. Transport
failures, timeouts and responses without a usable JSON error remain ambiguous;
recovery only polls their existing dispatch hash. Each recovery batch visits an
order at most once, including when a status query leaves its state unchanged.
