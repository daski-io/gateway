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

Agents start from one of three doors, and every door leads to the same setup
guide: the MCP server at `/mcp`, whose instructions point at the guide; the
guide itself at `/skills/setup.md`; or the installable skill at
`/skills/SKILL.md`. Load the full guide through `daski_get_setup_guide`
or a raw fetch. Diagnose the existing signer, discover contextual intake,
obtain the actual quote, and approve it through the pinned `daski buy` flow. Once a
signer is configured, the steady-state prompt is `Use Daski to [your task]`.

## Public surfaces

- `POST /outcomes/:providerAgentId/:outcomeId/requirements` and MCP
  `daski_get_outcome_requirements` return the published schema, conditional
  intake requirements, normalized selectors, and missing fields for a partial
  request. This catalog read creates no quote or order.
- `/.well-known/mcp.json` publishes the buyer CLI pin and EAS confirmation
  signing metadata. Authorized order responses include the onchain order key
  used by the CLI's delivery-review flow.
- `POST /outcomes/:providerAgentId/:outcomeId` issues a payment requirement and
  accepts the identical paid retry.
- `/orders/:handle/actions/*` exposes payer-authorized lifecycle actions.
- `/wallet/*` exposes wallet-authorized orders, reputation, assets, and asset
  actions.
- `/.well-known/x402` and `/public/v2/*` publish the active signed legacy rail
  and listing artifacts.
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
  contract addresses. `limit` accepts 1 to 200.
- `/public/v3/services` publishes the service-first dynamic catalog when the
  registration route group is enabled.
- `/public/v2/registry/*` exposes read-only ERC-8004 identity, Daski provider
  and service catalog state.
- `/mcp` exposes `daski_buy_outcome` and the standard order lifecycle tools.
- `/health/live` and `/health/ready` report process and dependency readiness.

The MCP surface also exposes read-only provider discovery, identity resolution,
and service lookup tools. Identity and catalog registration remain independent
of payment. Standard purchases register transaction-linked reputation against
the configured `ReputationStorage`; provider outcomes and payer confirmations
complete that record asynchronously.

There is no alternate payment rail, native facilitator endpoint, or legacy
paid MCP workflow. Direct on-chain provider/service registration remains valid;
gateway enrollment controls only discovery and orchestration in this gateway.

## Requirements

- Node.js 20 or newer
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

## Configuration

See [.env.example](.env.example) for the complete Base Sepolia template. The
core groups are:

- Runtime and database: `NODE_ENV`, `CHAIN_ID`, `PUBLIC_URL`, `DATABASE_URL`,
  `MIGRATION_DATABASE_URL`, and `TRUST_PROXY`.
- Standard facilitator: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and the signed
  facilitator profile in `STANDARD_RAIL_MANIFEST_JSON`.
- Evidence and screening: `BASE_RPC_URL`, optional `BASE_RPC_FALLBACK_URLS`,
  `STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH`,
  `STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH`, and `SANCTIONS_ORACLE_ADDRESS`.
- Signing role: `FACILITATOR_PRIVATE_KEY` for protocol artifacts and
  gas-funded Testnet reputation writes.
- Dynamic catalog: `DYNAMIC_SERVICE_REGISTRATION_ENABLED`,
  `CATALOG_OPERATOR_TOKEN`, and `CATALOG_REFRESH_INTERVAL_MS`. Registration
  routes are enabled by default and require an operator token. Disabling the
  route group does not stop checkout or refresh of existing registrations.
  Refresh runs every 240 seconds by default; use per-service operator visibility
  to stop discovery and new commerce for a service.
- Public projection: `CHAIN_PROJECTION_REFRESH_MS` sets how often the public
  reputation projection behind the chain document and the activity endpoint
  is refreshed in the background.

The HTTP listener binds every interface, including the unspecified IPv6
address in dual-stack mode, so Railway private networking
(`http://gateway.railway.internal:PORT`) reaches the gateway without the
public edge. `TRUST_PROXY` only affects requests that carry forwarding
headers; private-network callers are rate limited by their own address.

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
- `src/mcp/` contains the shared stateless MCP transport.
- `src/db/` contains migration history and the standard runtime database
  boundary.

The provider workflow and signed wire contract are documented in
[docs/service-registration-v1.md](docs/service-registration-v1.md). Checkout uses
active database-backed skill listings. Registration and activation require live
chain authority; new commerce requires successful authority and card validation
within five minutes. Existing orders retain their immutable listing snapshots.

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues through GitHub's
private vulnerability reporting.
