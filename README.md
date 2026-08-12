# Daski Gateway

The Daski gateway is the wallet-agnostic entry point to the
[Daski](https://daski.io) marketplace. Every paid outcome uses x402 V2
Exact-EVM with one externally operated standard facilitator. Daski policy,
order state, release evidence, provider dispatch, and refunds remain outside
the facilitator.

The gateway does not implement a local x402 facilitator and never holds a
buyer private key. Fixed outcomes use stock Exact-EVM authorizations. Outcomes
with buyer input use the published deterministic nonce recipe while retaining
the standard Exact-EVM wire format.

## Public surfaces

- `POST /outcomes/:providerAgentId/:outcomeId` issues a payment requirement and
  accepts the identical paid retry.
- `/orders/:handle/actions/*` exposes payer-authorized lifecycle actions.
- `/uploads/*` provides short-lived, single-use attachment capabilities.
- `/.well-known/x402` and `/public/v2/*` publish the active signed rail and
  listing artifacts.
- `/mcp` exposes `daski_buy_outcome` and the standard order lifecycle tools.
- `/health/live` and `/health/ready` report process and dependency readiness.

There is no alternate payment rail, native facilitator endpoint, or legacy
paid MCP workflow.

## Requirements

- Node.js 20 or newer
- PostgreSQL 16
- Reviewed standard-rail manifests and signer bindings
- Coinbase CDP facilitator credentials
- Two independently hosted Base RPC endpoints for chain evidence
- An S3-compatible private attachment bucket

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
- Evidence and screening: `STANDARD_RAIL_EVIDENCE_RPC_URLS`,
  `STANDARD_RAIL_FINALITY_CONFIRMATIONS`, `SANCTIONS_ORACLE_ADDRESS`, and
  `SANCTIONS_ORACLE_MODE`.
- Distinct gateway roles: the quote, dispatch, receipt, lifecycle, release,
  and refund keys under `STANDARD_RAIL_*_PRIVATE_KEY`.
- Refund reserve limits and private object-store credentials.

The runtime rejects mock chain mode, unknown USDC domains, missing standard
artifacts, signer-role overlap, and configuration that does not match the
signed release manifest.

## Verification

```bash
npm run typecheck
npm run build
npm test
```

The tests include PostgreSQL-backed evidence-locator behavior: one aggregated
release event may cover multiple orders, while deposit and refund locators are
globally single-use.

## Release tooling

```bash
npm run standard-rail:measure
npm run standard-rail:cutover
```

The cutover command requires the reviewed archive digest and destructive
cutover approval before applying the standard schema and runtime grants.
Deployment coordination lives in
[daski-io/deploy-testnet](https://github.com/daski-io/deploy-testnet).

## Architecture

- `src/standardRail/` contains signed artifacts, standard payment handling,
  evidence verification, state transitions, dispatch, refunds, and recovery.
- `src/http/` mounts only the standard HTTP surface.
- `src/mcp/` contains the shared stateless MCP transport.
- `src/db/` contains migration history and the standard runtime database
  boundary.

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues through GitHub's
private vulnerability reporting.
