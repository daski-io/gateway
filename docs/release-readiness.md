# Release readiness

Releases are run by the deploy-testnet coordinator
([daski-io/deploy-testnet](https://github.com/daski-io/deploy-testnet)) with two
commands: `prep` makes the next release green, fixing whatever blocks it in the
owning repository, and `go` ships it. The coordinator only checks that CI passed
on the exact `develop` commit and promotes the artifact that CI built: the
`ghcr.io/daski-io/gateway:<sha>` image whose immutable digest the Release image
workflow records. Every code-quality check therefore lives in this repository's
CI, and `develop` must always be releasable.

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
  ([docs/runtime-verification.md](runtime-verification.md)).
- A new environment variable is parsed in `src/config.ts` (rail settings in
  `src/standardRail/config.ts`), listed in `.env.example`, and documented in
  the README's Configuration section.
- Notes discipline stays as practiced: the release tag and its two-parent
  `release: vX.Y.Z` merge commit are the version of record (`src/version.ts`
  derives the runtime version from the deployed commit; nothing is edited for
  a release), and there is no changelog file. Document user-visible behaviour
  in `README.md`, `docs/` and `skills/` in the same change set as the code.
- Never leave `develop` red. A red push is fixed forward or reverted at once;
  it is never left for the release to sort out.
- Never merge to `main` or tag by hand. `main` is deployed by Railway and is
  written only by the coordinator's authorized `go`.

## What CI proves

| Workflow / job / step | What it proves |
| --- | --- |
| CI `validate` / Build | `npm run build` compiles `src/` with `tsconfig.build.json`, copies migrations and skills into `dist/`, and records `dist/build-identity.json` binding source inputs, lockfile, Dockerfile, outputs and toolchain. |
| CI `validate` / Typecheck (src + test) | `npm run typecheck` type-checks the whole repository including `test/`, so the mock layer cannot drift from the real interfaces. |
| CI `validate` / Test | `npm test` runs the vitest suite against PostgreSQL 16 (pgvector) on port 5433: complete clean-schema migrations, PostgreSQL-backed state and admission behaviour, signed artifacts, and `test/wireFixtures.test.ts` asserting that the committed fixtures equal what the real builders emit. |
| CI `validate` / Wire fixtures are freshly generated and committed | Regenerates `test/wire-fixtures/` with `UPDATE_WIRE_FIXTURES=1` and fails on any byte difference (`git diff --exit-code -- test/wire-fixtures`) or untracked fixture, so the committed files are exactly what the builders emit and the consumers' vendored copies compare byte for byte. |
| CI `validate` / Boot actual Dockerfile image on representative existing state | Builds the Dockerfile for the candidate SHA and runs `npm run test:startup -- --image ...`: the image's build identity matches the local build, and `dist/index.js` boots read-only on migrated representative state with split migration/runtime roles until both health endpoints answer. |
| CI `validate` / Archive qualified compiled runtime, Preserve candidate build and startup identity | Uploads the qualified `dist`, `build-identity.json` and the startup proof as `gateway-runtime-proof-<sha>` for 30 days. |
| CI `validate` / Audit dependencies | `npm audit --audit-level=high` fails on a high-severity advisory; registry transport failures are retried, not treated as findings. |
| Release image `image` / `docker/build-push-action` | Builds and pushes `ghcr.io/daski-io/gateway:<sha>` with `SOURCE_SHA` bound, provenance (`mode=max`) and an SBOM, and outputs the immutable digest. |
| Release image `image` / Pull the pushed image by digest, Scan the pushed image | Pulls the exact pushed digest back and runs Trivy 0.67.2 (pinned by digest) with `--severity MEDIUM,HIGH,CRITICAL --ignore-unfixed --exit-code 1`: the shipped image carries no fixable MEDIUM-or-higher OS or Node package advisory. The Dockerfile keeps this green by installing Debian's patched PCRE2 and removing npm/npx from the runtime stage. |
| Release image `image` / `actions/attest-build-provenance`, Record immutable image | Attests build provenance (public repositories) and uploads `release-image-<sha>` with the digest the coordinator promotes. A failed scan stops before this step, so no candidate artifact exists for a vulnerable image. |

## Follow-ups

- Prior-runtime compatibility on migration changes. The provider CI runs
  `bash scripts/reliability/prior-runtime.sh <base> <evidence>` when migration
  files change, booting the previous release on the expanded schema. The
  gateway has no equivalent: `scripts/reliability/startup-proof.mjs` accepts a
  `migrationThrough` boundary but always boots the candidate binary. Add a
  gateway `scripts/reliability/prior-runtime.sh` and wire it into `ci.yml`
  guarded by `git diff --name-only <base> HEAD | grep -E '^src/db/migrations/'`,
  as the provider's step is.
- The Dockerfile pins `libpcre2-8-0=10.42-1+deb12u1` (the provider's fix). When
  Debian supersedes that package the build fails loudly; bump the pin or move
  to a base image that already carries the fix.
- The `hono` override (`4.13.5`, three MEDIUM advisories in 4.13.0) can be
  dropped once `@modelcontextprotocol/node` requires that version or later.
