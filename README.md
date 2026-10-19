---
title: "Daski Gateway"
status: canonical
authority: current repository implementation and approved maintainer workflow
owner: repository maintainers
effective-date: 2026-10-16
last-verified: 2026-10-16 (documentation placement; no live release verification)
supersedes: repository-wide agent files as the home of general repository guidance
superseded-by: none
sensitivity: public-safe
related-repositories: daski-io/gateway
review-trigger: setup, architecture, interface or workflow change
---

# Daski Gateway

The Daski gateway is the wallet-agnostic entry point to the
[Daski](https://daski.io) marketplace. Every paid outcome uses x402 V2
Exact-EVM with one externally operated standard facilitator. Daski policy,
order state, release evidence, provider dispatch, and reputation remain outside
the facilitator.

The gateway does not implement a local x402 facilitator and never holds a
buyer private key. Fixed outcomes use stock Exact-EVM authorizations. Outcomes
with buyer input use the published deterministic nonce recipe while retaining
the standard Exact-EVM wire format.

## Buying through Daski

Agent documentation and the MCP server live on the website, at
`https://sandbox.daski.io/skills/setup.md` and `https://sandbox.daski.io/mcp`
for Testnet (`https://daski.io` on mainnet). The website owns the guides and
MCP tool definitions. Its tools call this gateway's REST API; payment validation,
quotation, settlement, order state, authorization, and dispatch stay here.

The gateway's old guide URLs redirect to the website. Its configured MCP path
returns a method-preserving HTTP 307 to the website's `/mcp`, so existing clients
can follow the redirect without rewriting a signed request. The gateway's
`/.well-known/mcp.json` remains the runtime authority for CLI versions, wallet
capabilities, and signing metadata, and advertises the website MCP address.

Load the full setup guide through `daski_get_setup_guide` or a raw fetch.
Diagnose the existing signer or set up the default Circle agent wallet,
discover contextual intake, obtain the actual quote, and approve it through
the gateway-pinned `daski buy` flow. Once a signer is configured, the
steady-state prompt is `Use Daski to [your task]`.

## Public surfaces

- `POST /outcomes/:providerAgentId/:outcomeId/requirements` and MCP
  `daski_get_outcome_requirements` return the published schema, conditional
  intake requirements, normalized selectors, and missing fields for a partial
  request. This catalog read creates no quote or order. Signed intake metadata
  permits validation-pattern keys up to 4,096 characters; buyer request keys
  remain limited to 128 characters.
- `/.well-known/mcp.json` publishes the buyer CLI pin, the accepted payer
  account types (`payerAccounts`: plain wallets always, deployed contract
  accounts when enabled, never counterfactual ones), the delivery
  confirmation modes (`confirmation`: sponsored for EOA payers, direct for
  contract payers, three attestations per order, revocation always), the
  signer CLI versions Daski's adapters are tested with (`signerClis`), and EAS confirmation signing metadata.
  Authorized order responses include the onchain order key used by the
  CLI's delivery-review flow, and order status carries the
  `confirmationFinal` state read at the configured finality tag.
- `POST /outcomes/:providerAgentId/:outcomeId` issues a payment requirement and
  accepts the identical paid retry.
- `/orders/:handle/actions/*` exposes payer-authorized lifecycle actions.
- `/wallet/*` exposes wallet-authorized orders, reputation, assets, and asset
  actions. An admitted entity document download returns a transient `download`
  object with its one-time provider URL and expiry. Clients GET that URL;
  `refreshAction` names the asset action for obtaining another link. Responses
  remain validated against the current signed action catalog. A provider's
  temporary unavailability during an asset action returns HTTP 503 with
  `WALLET_TEMPORARILY_UNAVAILABLE` and `Retry-After`. Retry the identical
  request and wallet authorization to resume the same action execution.
- `POST /v1/owner-swaps` accepts a provider-signed `ProviderOwnerSwapV1`
  notice that an asset's owner changed and grants the new payer eligibility
  for that provider's owner-only reads and actions; see
  [docs/owner-swaps-v1.md](docs/owner-swaps-v1.md). Off by default.
- `/openapi.json` publishes OpenAPI 3.1 for the currently admitted outcome
  catalog: concrete POST paths, input schemas, synthetic examples, fixed or
  dynamic USDC prices, and asynchronous purchase responses. `/.well-known/x402`
  links to it alongside the active signed rail and listing artifacts.
  Submit the **gateway origin** or its `/openapi.json` to x402 directories;
  scanners such as x402scan identify resources by the submitted origin, even
  when an OpenAPI document names a different server. The website's MCP
  manifest and agent guide link to the canonical gateway document.
- Payment challenges carry a compact, standard Bazaar HTTP declaration and
  hash-bound schema reference, preserving the existing 5 KiB buyer budget.
  After payment validation, the gateway supplies the full public input and
  asynchronous response schemas to the CDP facilitator on verify and settle,
  including when the buyer omitted optional discovery metadata. Examples
  derive only from published schemas, never a customer's request. Complex
  schemas that cannot produce a bounded example retain their exact OpenAPI
  contract and use a minimal Bazaar declaration with an `exampleUnavailable`
  indicator. Optional `EXTENSION-RESPONSES` indexing status is logged without
  changing payment success or replay semantics.
  Coinbase Bazaar indexing follows an accepted settled payment; directory
  submission, validation and editorial acceptance depend on each directory.
  Discovery examples do not satisfy provider eligibility or payer-bound DNS
  readiness by themselves, and a 202 purchase receipt means asynchronous work
  is pending. See [Coinbase discovery](https://docs.cdp.coinbase.com/x402/seller/get-discovered)
  and [x402scan's OpenAPI profile](https://www.x402scan.com/discovery/spec.md).
- `/.well-known/daski-chain.json` publishes metadata envelope v3 with
  `outcomeSchemaVersion: 1`. Consumers must ignore additive fields; removals,
  renamed fields, type changes, and semantic changes require a new schema
  version. The reputation projection behind it is refreshed in the
  background (`CHAIN_PROJECTION_REFRESH_MS`, 60 seconds by default) and after
  every finalized reputation write, so requests never wait on the chain.
  Responses carry `Cache-Control: public, max-age=30,
  stale-while-revalidate=300`, an `ETag`, and `DASKI-PROJECTION-REFRESHED-AT`.
  Each outcome's `providerReputation` and `serviceReputation` carry the
  additive `recoveredCount` (see [recovered orders](#recovered-orders)).
- `/public/v3/activity?limit=50` publishes the compact marketplace activity
  projection from the same warm data: the newest purchases across services
  with service and skill names, marketplace totals, the safe block, and the
  contract addresses. `limit` accepts 1 to 200. New orders preserve
  checkout service and skill names in their immutable listing snapshot, and
  activity shows exactly those names, including for superseded listings. A
  purchase whose local order is missing displays an unknown skill, never
  another skill from the same service.
- `/public/v3/services` publishes the service-first dynamic catalog when the
  registration route group is enabled. `/public/v3/services/:serviceId` adds
  the provider's and the service's on-chain reputation counters as
  `providerReputation` and `serviceReputation`, each with the additive
  `recovered` (see [recovered orders](#recovered-orders)).
- `/public/v2/registry/*` exposes read-only ERC-8004 identity, Daski provider
  and service catalog state. The provider and service reads carry the on-chain
  reputation counters as `standardReputation`, with the additive `recovered`.
- Both read chain state through a shared cache: a value is reused for 60
  seconds, then served while it is read again in the background, for up to
  24 hours if the chain cannot be read. Concurrent requests share one read.
  Authority, activation and checkout always read the chain live.
- `POST /outcomes/:providerAgentId/:outcomeId/quote` returns the prepared
  challenge and payer preflight. `POST .../purchase` accepts `{ request,
  payerAddress?, paymentPayload? }`, retaining the complete payment in JSON
  rather than requiring a large HTTP header. Both use the existing checkout
  service and gateway-bound authorizations.
  After validated payment authorization is durably captured, checkout waits at
  most five seconds for processing before returning HTTP 202 with the same
  order handle, the admission-state snapshot, and null receipts. Admission
  validation happens before this five-second processing budget. Settlement,
  chain evidence, and dispatch continue under the existing renewable order
  lease; a disconnect does not cancel them. Reconcile that payment identifier
  or use authorized order status after a timeout or pending response; never
  create another payment authorization to recover the purchase. A pending
  response confirms admission, not settlement or fulfillment.
  Purchases of the same outcome settle side by side: each payment lands in the
  listing's splitter, the first payout after it releases every deposit before
  it, and each order proves its own share of that payout. A listing stops
  settling only while an order on legal hold may still have money in its
  splitter; its verified purchases then wait for an operator. The proof
  reads the chain for the payout's predecessor from the payout downward, so
  its cost follows the time since the listing's previous payout, not the
  listing's age, and it reads the head again about when the payout's
  confirmations are due at the listing's signed block time.
  Outcomes declaring `purchaseReadiness: "payer_dns"` require `payerAddress`
  before quoting. A readiness rejection includes structured DNS records in
  `error.readiness`; install them and obtain a fresh quote before signing.
  Fixed and dynamic challenges retain the signed provider quote commitment
  and cannot outlive it; a fixed-price readiness quote lasts at most the
  five-minute draft window. Drafts and captured payments are bound to the quoted payer.
- `POST /public/v2/outcomes/search` provides bounded catalog search and
  vocabulary hints; `GET /public/v2/outcomes/:providerAgentId/:outcomeId`
  provides the complete detail with capped recent-purchase history.
- `POST /wallet/orders` accepts an optional `paymentIdentifier` for
  payer-authorized reconciliation. Each order's `reputation` carries the
  additive `recovery` (see [recovered orders](#recovered-orders)).
- `/mcp` redirects to the website's MCP server.
- `/health/live` and `/health/ready` report process and dependency readiness.

The website MCP surface also exposes read-only provider discovery, identity resolution,
and service lookup tools. Identity and catalog registration remain independent
of payment. Standard purchases register transaction-linked reputation against
the configured `ReputationStorage`; provider outcomes and payer confirmations
complete that record asynchronously.

### Recovered orders

A provider can later record on chain that it recovered an order whose outcome
was Failed. The order keeps its Failed outcome: the reputation contract records
the recovery beside it, so completed and failed counts, completion rate and
fulfillment timing are unchanged. The gateway reports recoveries in additive
fields, each read at the same block as the figures beside it:

- `recoveredCount` in every outcome's `providerReputation` and
  `serviceReputation` (the chain document, outcome search and outcome detail):
  of the Failed orders counted in `failedCount`, those later recovered.
- `recovered` in `standardReputation` on the `/public/v2/registry` provider and
  service reads, and in `providerReputation` and `serviceReputation` on
  `/public/v3/services/:serviceId`: the contract's recovered counter for that
  provider or service, read at the same safe block as the other counters. Only
  these public views read it, after their registry reads; the registry reads
  that registration, authority checks and checkout make never include it.
- `reputation.recovery` on each `POST /wallet/orders` order:
  `{ recoveredAt }`, the time of the recovery in unix seconds as a decimal
  string, or `recoveredAt: null` when the order was not recovered.

Recoveries are reported where the reputation contract at the read block is
implementation 2.2.0 or later, as its `version()` reports at that block. `null`
in place of any of these fields means recoveries are unsupported at that block
or could not be read; it never stands for zero, and a failed recovery read never
fails or changes the other figures.

There is no alternate payment rail, native facilitator endpoint, or legacy
paid MCP workflow. Direct on-chain provider/service registration remains valid;
gateway enrollment controls only discovery and orchestration in this gateway.

## Requirements

- Node.js 22 or newer (`nvm use` selects the development version)
- PostgreSQL 16
- Reviewed standard-rail manifests and signer bindings
- Coinbase CDP facilitator credentials
- Base RPC access for finalized chain evidence
- A gas-funded reputation relayer

## Local setup

```bash
git clone https://github.com/daski-io/gateway.git
cd gateway
npm install
cp .env.example .env
# Replace every placeholder. Do not use production or Testnet secrets locally.
npm run build
npm test
```

The runtime always starts the standard rail. `PAYMENT_RAIL` is intentionally
not a configuration option.

## Delivery review reliability

Sponsored reviews require `reviewProtocol: 2` on new prepare/submit requests.
Use the buyer version advertised in `/.well-known/mcp.json`. The gateway and
buyer independently verify pinned EAS implementation, domain and signed types:
Base native 1.0.1 and Base Sepolia native 1.2.0 use different delegation formats.
An unknown implementation disables new sponsored sends while receipt reconciliation continues.

A pending response includes its operation ID. A failed or unresolved submission
returns an error; only a finalized successful receipt reports success. Keep the
saved preparation and signature when resuming. A legacy 1.0.1 signature has no
expiry: the local five-minute admission/relay window does not cancel it. Buyers
can reaffirm an admitted intent or explicitly acknowledge a same-nonce alternative.
Only one alternative is relayed, all authorizations remain recorded, and the
group shares one sponsorship allowance and a maximum of five transaction attempts.
Any valid alternative may execute first. Direct calls do not consume the delegated nonce.

An unsubmitted preparation saved by an older buyer can be explicitly replaced
using its preparation ID after finalized chain evidence proves its recognized
signed deadline has expired. The original record remains available; live,
nonexpiring and unrecognized historical authorizations stay blocked.

Operator recovery exposes authenticated inventory, preview and apply endpoints
under `/operator/v1/reviews/recovery`. Apply requires the preview proof, a release
ID and an idempotency key. It verifies canonical finality evidence under the same
relayer/payer locks as submissions. It releases eligible failed sponsorship holds
without deleting attempts or pretending that missing receipts prove success.
Nonce advancement without an attributed receipt retires the authorization while
preserving its allowance charge. Review recovery is separate from generic
registration retries. The deployment coordinators consume the
`delivery-review-recovery` release scenario to stop old gateway workers before
new protocol writes and enforce fix-forward after cutover.

Circle estimate and execute capabilities are advertised separately. The execution
capability defaults off pending target qualification; the CLI transport adapter
is restricted to the reviewed Circle versions and EAS calls.

## Configuration

Release capability and commerce readiness use
`DASKI_COMMERCE_BASELINE_JSON`, a captured snapshot of offered contract hashes
and local prerequisite names. `STANDARD_RAIL_ASSET_ACTION_TARGET_EPOCHS_JSON`
is parsed for compatibility; the durable authenticated target controls activation.
See [runtime release controls](docs/release-controls.md) for the schemas,
scoped stop-sale, registration fences and compatibility evidence.


- `CONFIRMATION_CIRCLE_EXECUTION_QUALIFIED` defaults to `false`; set `true` only after the Circle direct-review execution and read-only resume qualification has passed for the target.

See [.env.example](.env.example) for the complete Base Sepolia template. The
core groups are:

- Runtime and database: `NODE_ENV`, `CHAIN_ID`, `CHAIN_FINALITY_TAG` (the block
  tag read as final: `safe` on Base Sepolia and `finalized` on Base mainnet by
  default), `PUBLIC_URL`, `DATABASE_URL`, `MIGRATION_DATABASE_URL`, and
  `EDGE_SECRET`. `DOCS_URL` is the public website origin used for guide and
  MCP links, defaulting to `https://sandbox.daski.io` on Base Sepolia and
  `https://daski.io` on Base mainnet. Override it for local or preview sites;
  it never changes payment audiences or signed resource URLs.
- Standard facilitator: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and the signed
  facilitator profile in `STANDARD_RAIL_MANIFEST_JSON`.
- RPC read pacing: RPC_READ_MAX_PER_MINUTE (default 300) is the whole read rate of one RPC endpoint, shared by every gateway client of that endpoint in a process. Size it to the endpoint's plan, so that the costliest read the gateway sends, `eth_getLogs`, still fits the plan's per-second limit at the full rate: Infura's Developer plan allows 4,000 credits a second and `eth_getLogs` costs 255, so 900 a minute. Payment proof reads are served first, then the registration proof reads that activate paid listings, then every other (ordinary) read. Whenever a level took the last slot it competed for while a lower level waited, the next slot goes to the lower levels: while payment proofs wait, at most one other read is dispatched before the next of them, and each waiting lower level gets at least every fourth slot. With every level backlogged, payment proofs get half the endpoint and registration proofs and ordinary reads a quarter each; a sustained payment-proof backlog alone leaves ordinary reads every other slot. Proof reads keep their place until served. Every other read waits at most two seconds from the moment its client presents it, and the slots proofs take meanwhile do not count against those two seconds: a proof backlog delays ordinary reads but does not expire them. Each client presents one read at a time to the endpoint queue (contract-signature verification: two, oldest verification first), however many parallel lanes it runs, so its reads go out in its turn among the other clients; a proof client serializes its own reads, so a proof read can also wait behind the earlier proof reads of its own client. Sanctions screening (every claimed purchase attempt runs it before the facilitator is asked to settle, and every owner swap runs it) reads through its own ordinary client, never the payment-proof client; it holds at most 4 reads and refuses more at once. A purchase attempt whose screening the endpoint cannot serve therefore fails before anything settles and recovery screens its claimed authorization again; an owner swap answers the retryable `SCREENING_UNAVAILABLE`. Ordinary clients hold at most 64 requests (contract-signature verification: 8) and refuse more at once; proof clients are not bounded. Explicit caller deadlines cover the entire queue. Expired or canceled reads never reach the endpoint or consume a reserved slot. A challenge's optional balance preflight waits up to five seconds at ordinary priority, behind payment and registration proofs, so a burst of challenges is served in turn; a read still unserved then leaves the challenge valid and reports an unavailable preflight. Transaction broadcast uses its separate durable path.
- Evidence and screening: `BASE_RPC_URL`, optional `BASE_RPC_FALLBACK_URLS`,
  `STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH`,
  `STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH`, and `SANCTIONS_ORACLE_ADDRESS`.
- RPC failover: a read runs as one observation on one endpoint, with any
  block it pins, trying `BASE_RPC_URL` first and each fallback in order. A
  deterministic answer (a revert that returned data, invalid params, an
  unknown method) is final. An endpoint fault (JSON-RPC `-32603`, an unknown
  block, HTTP 5xx, a network error) moves to the next endpoint at once; a
  rate limit or a timeout retries the same endpoint after a backoff that
  honors `Retry-After`; the last available endpoint keeps a bounded retry.
  Each endpoint has a circuit breaker shared by the whole process: three
  consecutive faults, or more than 20% of at least ten observations within a
  minute, open it, and an open endpoint is skipped for one minute, doubling
  up to ten minutes while the probe after each cooldown fails. One
  observation probes it and a success closes it. A local pacing refusal
  never counts, and when every endpoint is open they are all still tried,
  least recently opened first. Transitions log `RPC endpoint circuit opened`,
  `half-open` and `closed` with the endpoint host; endpoint faults log
  `RPC endpoint attempt failed` with host, method, code, attempt and latency,
  at most once a minute per kind; fallback selections name the operation and
  the primary's reason. URLs with paths, request bodies and keys are never
  logged. A read times out after 5 seconds (head, nonce, balance, code and
  calls at a block tag) or 15 seconds (`eth_getLogs`, multicalls and reads
  pinned to a block); explicit caller deadlines still apply. A log range is
  split only when the endpoint refuses its size or result count. A failed
  reputation broadcast is classified from the node's own error, never from
  the composed message that carries the raw transaction.
- Signing role: `FACILITATOR_PRIVATE_KEY` for protocol artifacts and
  gas-funded Testnet reputation writes.
- Reputation fees: `REPUTATION_MAX_FEE_PER_GAS_WEI` defaults to 3 gwei on
  Base mainnet (8453) and Base Sepolia (84532), and 100 gwei elsewhere; an
  explicit value overrides this. With the default 1,500,000 registration
  gas limit, the Base execution fee reserve is 0.0045 ETH. `balance_fee`
  failures log the reserve from the actual signed transaction (which may
  predate a configuration change). Account health also exposes registration
  and confirmation reserves for newly prepared transactions.
- Operator recovery: the bearer `CATALOG_OPERATOR_TOKEN` authorizes the
  audited [order redispatch, reputation retry and hidden-service inventory endpoints](docs/operator-recovery.md).
- Dynamic catalog: `DYNAMIC_SERVICE_REGISTRATION_ENABLED`,
  `CATALOG_OPERATOR_TOKEN`, and `CATALOG_REFRESH_INTERVAL_MS`. Registration
  routes are enabled by default and require an operator token. Disabling the
  route group does not stop checkout or refresh of existing registrations.
  Refresh runs every 240 seconds by default; use per-service operator visibility
  to stop discovery and new commerce for a service.
- Public projection: `CHAIN_PROJECTION_REFRESH_MS` sets how often the public
  reputation projection behind the chain document and the activity endpoint
  is refreshed in the background.
- Process memory: a serving gateway logs one `process memory` line every
  `MEMORY_REPORT_INTERVAL_MS` (300000, five minutes; `0` turns it off) with
  `rssMb`, `heapUsedMb`, `heapTotalMb`, `externalMb`, `arrayBuffersMb` and
  `heapSizeLimitMb`, in MiB.
- Payer accounts: `PAYER_ACCOUNT_TYPES` (`eoa` by default; `eoa,contract`
  admits deployed contract accounts whose `isValidSignature` verifies the
  EIP-712 hash through one bounded `eth_call`) and
  `PAYER_SIGNATURE_VERIFY_TIMEOUT_MS` (5000), the single deadline covering
  the code lookup, the call, and one RPC failover. Signatures are at most
  4,096 bytes; the call runs with 1,000,000 gas, a 16 KB response bound, and
  at most 8 concurrent verifications per process and 2 per requesting client
  (a public IPv6 client per /64).
  A verification refused for the client's share or a full RPC queue, or whose
  RPC wait expires, answers the retryable 503
  `SIGNATURE_VERIFICATION_UNAVAILABLE` (the same signature may be
  resubmitted), never `SIGNATURE_INVALID`; the process limit and the global
  admission answer 429 `SIGNATURE_VERIFICATION_BUSY`. The verification client
  is one ordinary reader of the shared endpoint and presents two reads at a
  time, so two verifications advance together. The process limit keeps its
  queue of 8 reads from filling, so an endpoint too busy to serve a
  verification's code lookup and call within the deadline shows as that
  retryable 503 when the deadline expires. On Base mainnet,
  `contract` requires `CONFORMANCE_EVIDENCE_RECORDED=1`.
- Owner swaps: `OWNER_SWAPS_ENABLED` (`false`) and
  `OWNER_SWAPS_PER_PROVIDER_PER_DAY` (50).

The HTTP listener binds every interface, including the unspecified IPv6
address in dual-stack mode, so Railway private networking
(`http://gateway.railway.internal:PORT`) reaches the gateway without the
public edge. Public requests reach the gateway only through Cloudflare:
`EDGE_SECRET` is the value the edge adds as `X-Daski-Edge-Secret` to every
request it forwards, a request without it is refused with 403
`EDGE_REQUIRED`, and the client address is the one Cloudflare names in
`CF-Connecting-IP`; forwarding chains are never counted. Private-network
callers are trusted for one forwarded hop (the website names the MCP client
it serves), and `/health/*` needs no header. Per-client limits (the rate
limits and the contract-verification share) count a public IPv6 client once
per /64, since one host can draw a fresh source address from its /64 for
every request; IPv4 addresses and private-network peers count exactly.

The runtime rejects mock chain mode, unknown USDC domains, missing standard
artifacts and configuration that does not match the
signed marketplace manifest.

## Verification

```bash
npm run typecheck
npm run build
npm test
```

The tests include a complete clean-schema migration smoke and PostgreSQL-backed
evidence-locator behavior: one aggregated release event may cover multiple
orders, while each deposit is globally single-use. Deployment coordination
lives in [daski-io/deploy-mainnet](https://github.com/daski-io/deploy-mainnet).

## Architecture

- `src/standardRail/` contains signed artifacts, standard payment handling,
  evidence verification, state transitions, dispatch, reputation, and recovery.
  Recovery drives claimed and verified authorizations on their own lane within
  seconds, since they expire unless settled; slower work such as provider
  polling runs on the main lane. The release wallet's nonce lock and the rail
  fence are held only to submit a payout, never across finality waits.
- `src/marketplace/` contains payment-independent finalized identity and
  service-registry reads.
- `src/serviceRegistration/` contains provider-authenticated enrollment,
  safe card loading, immutable preparation, evidence verification, refresh,
  visibility, and the service-first public catalog.
- `src/http/` mounts only the standard HTTP surface.
- `src/mcp/` retains request context and compatibility result helpers; the
  MCP server and tool definitions belong to the website repository.
- `src/db/` contains migration history and the standard runtime database
  boundary. A pooled connection the database ends, as a restart ends them
  all, is logged as `database connection lost` with the pool's name and the
  sanitized error; the gateway keeps serving and the next checkout connects
  again.

The provider workflow and signed wire contract are documented in
[docs/service-registration-v1.md](docs/service-registration-v1.md); the
provider owner-swap notice in [docs/owner-swaps-v1.md](docs/owner-swaps-v1.md). Checkout uses
active database-backed skill listings. Registration and activation require live
chain authority; new commerce requires successful authority and card validation
within five minutes. Existing orders retain their immutable listing snapshots.
An accepted order's fulfillment deadline runs from its original dispatch
resolution for the longest of its snapshot's duration, a longer duration
already recorded for it and the current listing's (30 days by default),
whether or not that listing is on sale; a longer duration is recorded before it
is used, so a shorter, paused or missing listing never shortens the deadline or
suspends it ([operator recovery](docs/operator-recovery.md)). Provider-reported
failure still takes effect immediately. An expired deadline fails the gateway
order without cancelling or refunding the provider's task, whose later
completion stays readable. Operators can
[revive a deadline-failed order](docs/operator-recovery.md) when its existing
provider task is still active. No dispatch envelope, first or fresh, is signed
for an order more than 30 days after its quote expired
(`MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS`): the order is held instead
(`LEGAL_HOLD`, `first_dispatch_quote_age_exceeded`), and providers may retire a
quote once that bound and their own margin have passed
([operator recovery](docs/operator-recovery.md)).

Admitted DNS and capacity waits appear in signed order `operations.fulfillment`.
They pause the fulfillment clock; stale progress creates an incident, without
turning a propagation delay into a paid failure. Support requests require
`{ requestId, message }`; retain the request ID but obtain a fresh wallet
authorization when retrying. `result.supportReceipt` returns the original receipt
for that request ID, including after newer messages; `operations.support` shows
the latest accepted request and Review state. Each operations view carries a
revision; a view older than the stored one is still returned to its caller but
never replaces the newer stored view. A completed provider recovery appears as `fulfillmentState: "recovered"`
and `operations.recovery`, while the original failed order and its Failed reputation
outcome remain unchanged. A recovery the provider also records on chain is a
separate recovery record that the reputation contract keeps beside that outcome
(see [recovered orders](#recovered-orders)). Status and artifact reads always
obtain fresh provider evidence.

A provider can refuse an order action with an exact body whose only key is
`error`, at most 1 KiB of uncompressed JSON. 409 `unsupported_action` answers
the buyer HTTP 409 `ORDER_ACTION_UNSUPPORTED`: the provider changed nothing and
the action is not retried. 409 `action_conflict` answers HTTP 409
`ORDER_ACTION_CONFLICT`: the action's identity, such as a support `requestId`,
is already bound to different content, which the provider keeps. 503
`lifecycle_unavailable` answers HTTP 503 `PROVIDER_LIFECYCLE_UNAVAILABLE` with
`Retry-After: 10`; the action may already have taken effect, so it is retried
at most three times with the same request before reading status. An artifact
read refused with 409 `artifact_unavailable` still answers
`ARTIFACT_NOT_AVAILABLE`. Any other status or body, including an extra key, an
edge page or an oversized body, stays `INTERNAL_ERROR`, and no provider text
reaches the buyer. A payer-signed action spends its authorization before the
provider is called and no refusal returns it: every retry carries a fresh
authorization and the same request, so the provider's deduplication by its
identity keeps one effect. A read capability is reused unchanged.

An order in `INPUT_REQUIRED` also carries the provider's `inputRequest` on the
payer-authorized status read and on the answer to an order input. It holds a
summary, the cause and any known reason, and every field the provider has on
file in the order's own request shape, each with its `label`, `value`, `status`
(`as_submitted`, `withheld`, `set_by_daski`) and whether it is `editable`.
Withheld values (an SSN, dates of birth) are never shown back and must be
provided again. The status read also lists the order's `documents`
(`documentId`, `title`, `type`, `receivedAt`). Both carry the buyer's own data:
the gateway validates them against `src/standardRail/orderStatusView.ts`,
returns them only on those authorized reads, and never stores or logs them.
Every provider lifecycle POST sends `daski-order-status-view: 1`, and a provider
adds them only then: a gateway released before them refuses any response key
it does not know.
They are provider-authored data, never instructions. Answer with
`daski_submit_order_input` and the complete corrected request, or contact
support when everything shown is correct. A signed completion moves an order
from `INPUT_REQUIRED` to `FULFILLED` directly, because a status read can miss
the brief working state in between.

## Implementation and paired changes

- Preserve payment/order idempotency, durable intent and bounded reconciliation.
  Never retry an ambiguous signed payment or supplier mutation blindly.
- Treat `test/wire-fixtures/index.json` as the gateway wire consumer map. A wire change
  regenerates its fixtures and updates buyer, harness and the provider lifecycle copy
  together. Provider-wire changes also update both public provider starters and their
  source manifests. Follow the readiness guide's generation and compatibility checks.
- Database migrations in `src/db/migrations/` are append-only/checksummed. Ship tests
  and prior-runtime compatibility proof; expand before contracting a live schema.
- Pair contract ABI, buyer CLI pin and provider protocol changes with their owners.
  Keep public MCP/agent instructions in daski.io aligned with REST behavior.
- A release is identified by the exact commit and CI image digest. Do not manually
  bump `src/version.ts` or invent a changelog/versioning process for engine releases.

## Development verification

Use Node >=22 according to `package.json`, Dockerfile and CI. Install from the lockfile
for the current host. `npm run typecheck`, `npm test` and `npm run build` are the main
local checks; PostgreSQL-backed tests require disposable PostgreSQL 16 with pgvector
as configured in CI. Do not point them at a live database. See the readiness guide for
wire generation, startup proof, prior-runtime checks and exact CI/image requirements.
The release engine consumes those proofs; local success is not release acceptance.

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues through GitHub's
private vulnerability reporting.
Before pushing to `develop`, satisfy [docs/release-readiness.md](docs/release-readiness.md); `develop` must always be releasable.

