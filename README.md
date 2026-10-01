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
- `/public/v3/activity?limit=50` publishes the compact marketplace activity
  projection from the same warm data: the newest purchases across services
  with service and skill names, marketplace totals, the safe block, and the
  contract addresses. `limit` accepts 1 to 200. New orders preserve
  checkout service and skill names in their immutable listing snapshot, and
  activity shows exactly those names, including for superseded listings. A
  purchase whose local order is missing displays an unknown skill, never
  another skill from the same service.
- `/public/v3/services` publishes the service-first dynamic catalog when the
  registration route group is enabled.
- `/public/v2/registry/*` exposes read-only ERC-8004 identity, Daski provider
  and service catalog state.
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
  payer-authorized reconciliation.
- `/mcp` redirects to the website's MCP server.
- `/health/live` and `/health/ready` report process and dependency readiness.

The website MCP surface also exposes read-only provider discovery, identity resolution,
and service lookup tools. Identity and catalog registration remain independent
of payment. Standard purchases register transaction-linked reputation against
the configured `ReputationStorage`; provider outcomes and payer confirmations
complete that record asynchronously.

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
- RPC read pacing: RPC_READ_MAX_PER_MINUTE (default 300) spaces read requests across gateway clients sharing one endpoint in a process. Transaction broadcast uses its separate durable path.
- Evidence and screening: `BASE_RPC_URL`, optional `BASE_RPC_FALLBACK_URLS`,
  `STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH`,
  `STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH`, and `SANCTIONS_ORACLE_ADDRESS`.
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
- Payer accounts: `PAYER_ACCOUNT_TYPES` (`eoa` by default; `eoa,contract`
  admits deployed contract accounts whose `isValidSignature` verifies the
  EIP-712 hash through one bounded `eth_call`) and
  `PAYER_SIGNATURE_VERIFY_TIMEOUT_MS` (5000), the single deadline covering
  the code lookup, the call, and one RPC failover. Signatures are at most
  4,096 bytes; the call runs with 1,000,000 gas, a 16 KB response bound, and
  at most 8 concurrent verifications per process. On Base mainnet,
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
it serves), and `/health/*` needs no header.

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
lives in [daski-io/deploy-testnet](https://github.com/daski-io/deploy-testnet).

## Architecture

- `src/standardRail/` contains signed artifacts, standard payment handling,
  evidence verification, state transitions, dispatch, reputation, and recovery.
- `src/marketplace/` contains payment-independent finalized identity and
  service-registry reads.
- `src/serviceRegistration/` contains provider-authenticated enrollment,
  safe card loading, immutable preparation, evidence verification, refresh,
  visibility, and the service-first public catalog.
- `src/http/` mounts only the standard HTTP surface.
- `src/mcp/` retains request context and compatibility result helpers; the
  MCP server and tool definitions belong to the website repository.
- `src/db/` contains migration history and the standard runtime database
  boundary.

The provider workflow and signed wire contract are documented in
[docs/service-registration-v1.md](docs/service-registration-v1.md); the
provider owner-swap notice in [docs/owner-swaps-v1.md](docs/owner-swaps-v1.md). Checkout uses
active database-backed skill listings. Registration and activation require live
chain authority; new commerce requires successful authority and card validation
within five minutes. Existing orders retain their immutable listing snapshots.
The operational fulfillment deadline for accepted orders uses the listing's current policy,
with a default of 30 days, including orders placed under the former one-hour
default. Provider-reported failure still takes effect immediately. Operators can
[revive a deadline-failed order](docs/operator-recovery.md) when its existing
provider task is still active.

Admitted DNS and capacity waits appear in signed order `operations.fulfillment`.
They pause the fulfillment clock; stale progress creates an incident, without
turning a propagation delay into a paid failure. Support requests require
`{ requestId, message }`; retain the request ID but obtain a fresh wallet
authorization when retrying. `result.supportReceipt` returns the original receipt
for that request ID, including after newer messages; `operations.support` shows
the latest accepted request and Review state. Each operations view carries a
revision; a view older than the stored one is still returned to its caller but
never replaces the newer stored view. A completed provider recovery appears as `fulfillmentState: "recovered"`
and `operations.recovery`, while the original failed order and reputation outcome
remain unchanged. Status and artifact reads always obtain fresh provider evidence.

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues through GitHub's
private vulnerability reporting.
Before pushing to `develop`, satisfy [docs/release-readiness.md](docs/release-readiness.md); `develop` must always be releasable.

RPC_READ_MAX_PER_MINUTE defaults to 300 in the gateway. This release does not
require a deployment variable change for that default.
