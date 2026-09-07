# Runtime verification

Gateway CI exercises complete PostgreSQL migrations, real servicing-admission
transactions, registration atomicity, and the actual compiled application
entrypoint. The historical coverage gap was an existing admission whose serving
profile epoch stayed unchanged while its catalog changed: a fresh database alone
could not reproduce it. The owning tests now check rejection against prior state,
rollback of partially applied chains, and a valid explicit successor.

`npm run build` records `dist/build-identity.json`. It binds source inputs,
lockfile, Dockerfile, compiled outputs, source revision, and build toolchain.
`npm run build:verify` refuses stale outputs. Docker builds require `SOURCE_SHA`, or the Git-triggered Railway
`RAILWAY_GIT_COMMIT_SHA` build argument. Both Docker stages declare these arguments
so the existing Git-source deployment path retains its source identity. See
[Railway Docker build variables](https://docs.railway.com/builds/dockerfiles).
CI also boots the actual Dockerfile image, with a read-only filesystem and no data
volume, and saves its identity and readiness proof. The fixture transport supplies
explicit versioned chain facts and facilitator capability IO; it does not mock
application validators, signatures, migrations, roles or admission transactions.
No live deployment or payment is made.

## Admission proof

After building, set `DATABASE_URL_TEST` to a disposable loopback PostgreSQL server
and run:

```bash
npm run release:proof -- --input candidate.json --output proof.json
```

The closed version-one input has `schemaVersion: 1`, `priorState` rows containing
`admission` (the full signed envelope) and `current` (boolean),
`candidateAdmissions` (full signed envelopes), and `expectedCurrent` entries
containing `providerAgentId` and `admissionHash`. Prior rows represent an observed,
sanitized database snapshot, including retained history where relevant. The proof
runs complete migrations, seeds that snapshot in a new random schema, invokes
`StandardAssetFederation.activateAdmissions`, verifies the exact expected current
rows, and repeats activation to check idempotence. It drops only its own schema.
This admission proof complements signed manifest validation; it does not claim
that admission activation alone verifies the whole manifest or external chain.

## Application startup proof

```bash
npm run test:startup -- --input startup.json --output startup-proof.json
npm run test:startup -- --input startup.json --image gateway-candidate --output image-proof.json
```

Omitting `--input` selects the versioned repository fixture used by CI. Supplied
inputs are never replaced by that fixture. The input contains `schemaVersion: 1`,
`fixtureVersion: 1`, `manifest`, `priorState`, `expectedCurrent`, `trustedSigners`,
and `rpcFacts`. An optional `runtimeConfig` is restricted to the public contract,
USDC and splitter settings enumerated by the driver; credentials cannot be
overridden. `scripts/reliability/fixture.mjs` defines an executable example.
All signatures use isolated test trust; public candidate facts can be re-signed
with test identities as part of controlled integration preparation. Existing
production secrets must never appear in fixture inputs or output evidence.

`migrationThrough` optionally selects a prior migration boundary before the actual
entrypoint applies remaining migrations. This exercises schema expansion with
existing state; it does not by itself certify a different prior binary.
`registrations` optionally supplies actual store operations: `create` arguments,
`evidence`, `commitments`, and optional `checkpoints`. These run the product store's
create/evidence/activate path before boot. They do not replace independent chain
verification of protected registration evidence.

The driver exports `proveStartup(input, databaseUrl, { probe })`. Its asynchronous
probe receives `{ url, databaseUrl }` while the candidate runs. CLI callers can
use `--probe-command '["node","probe.mjs","{gatewayUrl}"]'`. `providerRoutes`
can map an explicit HTTPS origin and allowed `paths`/`methods` to an actual local
HTTP candidate provider through a loopback `target`. This preserves real provider
request/response behavior while replacing only network transport. Unconfigured
RPC methods, facts, DNS and HTTPS requests fail closed; payment endpoints have no
fixture implementation. The only facilitator operation supported is capability
inspection.

Each run creates a unique database and an unprivileged runtime role, boots
`dist/index.js` with distinct migration/runtime roles, requires both health
endpoints, and checks actual admission state. It terminates its process/container
and removes only those disposable resources. For Docker Desktop, `--image-db-container <disposable-container>` verifies that
the named PostgreSQL container publishes the supplied loopback port, then routes
only the newly created database to its private bridge address.
The Docker mode verifies source and
content identity inside the exact image before startup. A startup proof covers
the given artifact/state combination; retained-runtime rollback combinations must
be supplied and qualified separately by release coordination.

Proof fields include `schemaVersion`, `repo`, `boundary`, `status`, `execution`,
`identity`, `inputHash`, `startingStateHash`, and `checks`. Hashes are lowercase
SHA-256 hex, with JSON inputs hashed using `JSON.stringify` in received property
order. Admission hashes remain the product's canonical keccak hashes. A nonzero
exit or `FAIL`, a stale build, wrong input hash or missing execution proof must
not certify a candidate. Release policy and orchestration are owned by the deploy
repository.

The complete-migration admission test replaces its hand-created partial table.
The candidate proof is the replacement consumer boundary for deploy-side copied
admission decisions; orchestration should invoke it instead of maintaining a
second decision implementation. Build identity and real boot close previously
missing coverage and therefore have no safe older runtime check to delete.
