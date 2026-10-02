# Release readiness

Releases are run by the deploy-testnet coordinator
([daski-io/deploy-testnet](https://github.com/daski-io/deploy-testnet)) with two
commands: `prep` makes the next release green, fixing whatever blocks it in the
owning repository, and `go` ships it. The coordinator only checks that CI passed
on the exact `develop` commit and promotes the artifact that CI built: the
`ghcr.io/daski-io/gateway:<sha>` image whose immutable digest the Release image
workflow records. Every code-quality check therefore lives in this repository's
CI, and `develop` must always be releasable.

Three branches carry a release. `develop` integrates. `sandbox` is what runs on
the testnet sandbox: `go` merges the `develop` → `sandbox` release pull request
at the exact commit CI proved and tags the merge commit `vX.Y.Z`, and Railway
deploys `sandbox` to the sandbox. `main` is production: it moves only by
fast-forward, performed by the production coordinator, to a release commit that
already ran on the sandbox. An emergency fix branches from `main` as
`hotfix/<id>`.

## Definition of done for develop

- CI is green on the pushed commit: the `validate` job in
  `.github/workflows/ci.yml` and the `image` job in
  `.github/workflows/release-image.yml`, including the image build and the
  Trivy scan of the pushed digest.
- An API or wire-shape change regenerates `test/wire-fixtures/`
  (`UPDATE_WIRE_FIXTURES=1 npx vitest run test/wireFixtures.test.ts`) and
  updates the consumers' vendored copies in the same change set:
  `daski-test/test/fixtures/gateway-wire/` and
  `daski-buyer/test/fixtures/gateway-wire/` (and
  `daski-provider/test/fixtures/gateway-wire/provider-lifecycle-request.json`
  for the provider lifecycle body). `test/wire-fixtures/index.json` lists which
  consumer vendors which file; the coordinator fails PREP when a vendored copy
  differs byte for byte.
- A migration in `src/db/migrations/` ships with its compatibility test: the
  complete clean-schema run in `test/migrationsPostgres.test.ts` must still
  pass, a migration that reshapes existing rows gets a PostgreSQL-backed test
  that seeds the prior state and asserts the post-migration read (the
  `*Postgres.test.ts` files are the pattern), and expansion on existing state
  can be exercised through the startup proof's `migrationThrough` input
  ([docs/runtime-verification.md](runtime-verification.md)). The previous
  runtime must still boot on the migrated schema, because a rollback and the
  old instance during a deploy run on it: expand in one release and contract
  in a later one. CI proves it on every run for the gateway production serves
  (pinned in `ci.yml`) and, whenever `src/db/migrations/` changes, for the
  previous head; `bash scripts/reliability/prior-runtime.sh <base sha>` runs
  the same proof locally.
- A new environment variable is parsed in `src/config.ts` (rail settings in
  `src/standardRail/config.ts`), listed in `.env.example`, and documented in
  the README's Configuration section.
- Notes discipline stays as practiced: the release tag and its two-parent
  `release: vX.Y.Z` merge commit are the version of record (`src/version.ts`
  derives the runtime version from the deployed commit; nothing is edited for
  a release), and there is no changelog file. Document user-visible behaviour
  in `README.md` and `docs/` (agent guides are website-owned) in the same change set as the code.
- Never leave `develop` red. A red push is fixed forward or reverted at once;
  it is never left for the release to sort out.
- Never merge to `sandbox` or `main` or tag by hand. `sandbox` is deployed by
  Railway to the sandbox and is written only by the coordinator's authorized
  `go`; `main` is production and is moved only by the production coordinator's
  fast-forward.

## What CI proves

CI runs on every push to `develop`, `sandbox`, `main` and `hotfix/**`, and on
pull requests into `develop`. The release merge commit on `sandbox` therefore
gets its own push run, which production promotion reads as the proof for that
exact commit. The Release image workflow runs on `develop` pushes.

| Workflow / job / step | What it proves |
| --- | --- |
| CI `validate` / Build | `npm run build` compiles `src/` with `tsconfig.build.json`, copies migrations into `dist/`, and records `dist/build-identity.json` binding source inputs, lockfile, Dockerfile, outputs and toolchain. |
| CI `validate` / Typecheck (src + test) | `npm run typecheck` type-checks the whole repository including `test/`, so the mock layer cannot drift from the real interfaces. |
| CI `validate` / Test | `npm test` runs the vitest suite against PostgreSQL 16 (pgvector) on port 5433: complete clean-schema migrations, PostgreSQL-backed state and admission behaviour, signed artifacts, and `test/wireFixtures.test.ts` asserting that the committed fixtures equal what the real builders emit. |
| CI `validate` / Wire fixtures are freshly generated and committed | Regenerates `test/wire-fixtures/` with `UPDATE_WIRE_FIXTURES=1` and fails on any byte difference (`git diff --exit-code -- test/wire-fixtures`) or untracked fixture, so the committed files are exactly what the builders emit and the consumers' vendored copies compare byte for byte. |
| CI `validate` / Boot actual Dockerfile image on representative existing state | Builds the Dockerfile for the candidate SHA and runs `npm run test:startup -- --image ...`: the image's build identity matches the local build, and `dist/index.js` boots read-only on migrated representative state with split migration/runtime roles until both health endpoints answer; then again with `--fixture post-epoch`, the state an epoch reset leaves (every migration applied, only the four lineage tables `standard_rail_artifacts`, `standard_provider_servicing_admissions`, `standard_service_registrations` and `standard_service_listings` populated, every other table empty) with a manifest that chains onto those rows, the class of the 2026-09-15 boot failure. |
| CI `validate` / Actual serving prior runtime on expanded schema | Runs on every push and pull request. `scripts/reliability/prior-runtime.sh <base>` with `base` pinned in `ci.yml` to the gateway commit production serves (`c018b4b89d90cd0250ca05006718074e7a1346d8`, observed read-only on 2026-10-02 and updated through review when the deployed baseline changes, never inferred from `develop`) builds that commit in a temporary worktree and runs the startup proof with `--prior-root`: the candidate's complete migrations prepare a disposable database, and the serving commit's compiled `dist/index.js` boots on it, with state its own fixture signs, until both health endpoints answer. `.tmp/gateway-prior-runtime-evidence.json` records both build identities, the `prior-runtime-expanded-schema` check and the migrations only the candidate carries; release qualification requires its `priorIdentity.sourceSha` to be the serving commit. |
| CI `validate` / Prior runtime on expanded schema (migration changes) | Runs only when `git diff --name-only <base> HEAD` lists a file under `src/db/migrations/`; the base is the pull request base, else the head the push replaced, else the parent commit. The same script proves that base commit's runtime boots on the candidate's schema and writes `.tmp/gateway-prior-head-runtime-evidence.json`. |
| CI `validate` / Archive qualified compiled runtime, Preserve candidate build and startup identity | Uploads the qualified `dist`, `build-identity.json`, the startup proofs, the serving-baseline prior-runtime evidence and, when it ran, the previous-head prior-runtime evidence as `gateway-runtime-proof-<sha>` for 30 days. |
| CI `validate` / Audit dependencies | `npm audit --audit-level=high` fails on a high-severity advisory; registry transport failures are retried, not treated as findings. |
| Release image `image` / `docker/build-push-action` | Builds and pushes `ghcr.io/daski-io/gateway:<sha>` with `SOURCE_SHA` bound, provenance (`mode=max`) and an SBOM, and outputs the immutable digest. |
| Release image `image` / Pull the pushed image by digest, Scan the pushed image | Pulls the exact pushed digest back and runs Trivy 0.67.2 (pinned by digest) with `--severity MEDIUM,HIGH,CRITICAL --ignore-unfixed --exit-code 1`: the shipped image carries no fixable MEDIUM-or-higher OS or Node package advisory. The Dockerfile keeps this green by installing Debian's patched PCRE2 and removing npm/npx from the runtime stage. |
| Release image `image` / `actions/attest-build-provenance`, Record immutable image | Attests build provenance (public repositories) and uploads `release-image-<sha>` with the digest the coordinator promotes. A failed scan stops before this step, so no candidate artifact exists for a vulnerable image. |

## Hand-off to the release agent

The release agent reads nothing but your commits. If a change needs anything at
deploy time beyond merging, put it in git trailers on the commit that needs it,
one per line at the end of the commit message:

```
Release-Variable: gateway PAYER_ACCOUNT_TYPES=eoa,contract before-deploy
Release-Requires: new-epoch
Release-Scenarios: entity-recipe
Release-Owner-Task: Send a signed owner-swap notice from the sandbox provider wallet, see docs/owner-swaps-v1.md
Release-Rollback: leave the flag on once a contract wallet has paid
```

- `Release-Variable`: service is `gateway`, `provider` or `daski-website`; the
  value is a literal or `staged`, meaning the owner sets the real value on
  Railway and the commit never carries a secret; the timing is `before-deploy`
  or `after-deploy`. A later commit overrides an earlier one for the same
  service and variable. A key you add to `.env.example` must appear in a
  `Release-Variable` trailer; write `Release-Variable: none NAME` when it needs
  no deployment change.
- `Release-Requires`: an environment operation the owner must authorize:
  `new-epoch`, `reregister:<service>` or `contract-upgrade`.
- `Release-Scenarios`: the acceptance scenarios the change touches, so the
  release runs them.
- `Release-Owner-Task`: work only the owner can do after the release. It is
  listed once in the release summary and never asked during the release.
- `Release-Rollback`: one line on how to undo the change if the release is
  rolled back.

Do not write runbooks or instructions for the release agent anywhere else. CI
runs `scripts/check-release-trailers.mjs` over every pushed commit.

## Follow-ups

- The Dockerfile pins `libpcre2-8-0=10.42-1+deb12u1` (the provider's fix). When
  Debian supersedes that package the build fails loudly; bump the pin or move
  to a base image that already carries the fix.
- The `hono` override (`4.13.5`, three MEDIUM advisories in 4.13.0) can be
  dropped once `@modelcontextprotocol/node` requires that version or later.

## Mailbox DNS preparation contract

The provider owns eligibility for optional `dnsSetup: "automatic"` purchases.
The gateway forwards this choice unchanged and binds it into the request hash
and payer-bound provider quote. It must not reuse a manual-mode quote for an
automatic-mode request. External domains retain the provider's ownership and
DNS gate before payment. An admitted automatic order can wait in `dns_pending`;
the existing durable-wait clock and lifecycle projection apply unchanged.

## Runtime continuity

Workers start after the application binds its HTTP listener and local compatibility has passed; no health request is needed to resume retained work. Public liveness uses a shared in-flight local readiness observation cached for two seconds. It does not share an admission bucket with anonymous callers behind the same proxy. Signed registration fences reject malformed signatures before charging the shared RPC admission limit, which accounts for up to nine reads per attempt and three attempts per endpoint. Authenticated coordinator deliveries have independent ingress admission while retaining the same actual RPC pacing. RPC_READ_MAX_PER_MINUTE (default 300) paces the gateway read clients together per RPC endpoint; it does not retry failed calls. Payment and registration proof reads are served first at the endpoint and keep their place until served, alternating with other waiting reads so neither class starves; every other read waits at most two seconds once it reaches the client queue head. Each client holds at most 64 requests and presents one at a time to the endpoint queue whatever its parallel lanes; contract-signature verification holds at most 8 queued reads and at most 2 verifications per requesting client, and answers a refused or expired wait with the retryable SIGNATURE_VERIFICATION_UNAVAILABLE, never SIGNATURE_INVALID. Explicit caller deadlines still cover the entire queue, and cancellation removes pending work without consuming a future slot. Optional quote balance preflight cannot reserve a future slot; overload leaves the challenge valid with its existing unavailable-preflight note.

Migration 055 replaces ordinary sale-guard writes with a lock on a preseeded row. Additive migration 054a installs an insert trigger before the immutable 055 backfill and repairs any existing missing rows under the trigger installation lock; 056 removes only this temporary trigger after 055 installs the permanent one. Pending 056–058 are applied atomically, with 50 ms lock waits and transaction retries so incumbent readers and writers can continue between attempts. Old migration checksums remain unchanged. Release controls still update that row, so legacy serializable claims reject stale stop-sale snapshots without making an unrelated settlement invalidate an ordinary claim. The standard-settlement-parked-v1 format declares the compiled worker's durable parked-authorization recovery support; a legacy image without that capability is not an eligible overlap after stop-sale.

A broken listing outside the captured offered baseline is omitted from the local inventory. Every exact baseline listing remains required. Historical asset-action recovery continues to require the original signed admission, catalog, and control profile in the carried manifest on both gateway and provider; changing the current epoch does not rebind prior work.

The ongoing state proof runs after both exact revisions are built:

    node scripts/reliability/state-compatibility.mjs --prior-root /path/to/fallback --output state-proof.json

It requires disposable loopback PostgreSQL. Candidate code writes order authorization, signed dispatch, and encrypted review transaction records; the fallback's actual parsers and journal/worker methods resume those same identities. Review transaction transport is in memory and never reaches a chain. The receipt lists exactly the formats exercised and both manifest byte hashes; parked-work coverage is added only when the fallback declares that capability. Unsupported formats never receive coverage merely from a manifest declaration.

Post-completion artifact delivery validates the projection declared by the exact
paid listing schema: task-shaped contracts validate the task, and flat contracts
validate their declared artifact data fields. The signed provider response and
its original artifacts remain unchanged, and passive-output validation checks
the entire response. Runtime commerce capabilities bind the complete executable
skill contract to an executable definition hash; only operator-owned pricing is
excluded from that hash. Historical action definitions may coexist in separately
signed catalog epochs; recovery resolves the claim's original admission,
catalog and definition hashes, never the currently active version.

Migration 058 keeps generic confirmation, revocation, reputation reconciliation
and support bookkeeping available on fulfilled orders after contract retirement.
New order, settlement, dispatch and asset-action admission remain fenced.
Required RPC evidence tests run the actual release and registration proof methods
through the ordered transport at the default budget and slow archive latency.
A fresh database still requires signed genesis lineage; a missing lineage is
reported with the safe SERVICING_GENESIS_MISSING diagnostic code.
