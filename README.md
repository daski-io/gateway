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
`/skills/SKILL.md`. Read the guide verbatim, through the `daski_get_setup_guide`
tool or `curl -fsSL`, because a summarizing fetch drops instructions. Once a
signer is configured, the steady-state prompt is `Use Daski to [your task]`.

## Public surfaces

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
  version.
- `/public/v3/services` publishes the service-first dynamic catalog when the
  dark-launch registration feature is enabled.
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
  `CATALOG_OPERATOR_TOKEN`, and `CATALOG_REFRESH_INTERVAL_MS`. It is disabled
  by default until the separately authorized R3 cutover.

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
[docs/service-registration-v1.md](docs/service-registration-v1.md). Dynamic
registrations are intentionally shadow-only until a sealed R3 release switches
new commerce from the historical static listings to database-backed skill
heads.

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues through GitHub's
private vulnerability reporting.
