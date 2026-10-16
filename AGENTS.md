---
title: gateway agent instructions
status: canonical
authority: repository implementation and current release-engine decisions
owner: repository maintainers
effective-date: 2026-10-16
last-verified: 2026-10-16
supersedes: earlier local-path or split-coordinator guidance where inconsistent
superseded-by: none
sensitivity: public-safe
related-repositories: daski-io/gateway; see interface owners below
review-trigger: architecture, toolchain, interface or release-process change
---

# Gateway contributor guide

Owns public REST discovery, payment/order orchestration and gateway projections.
The website repository owns public MCP and buyer agent guides; the integrated provider
owns fulfillment and assets. Read `docs/release-readiness.md` for exact CI and handoff
requirements. Current code controls behavior; do not revive retired PaymentRouter,
buyer ERC-8004 registration or old directory-platform assumptions.

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

## Local checks

Use Node >=22 according to `package.json`, Dockerfile and CI. Install from the lockfile
for the current host. `npm run typecheck`, `npm test` and `npm run build` are the main
local checks; PostgreSQL-backed tests require disposable PostgreSQL 16 with pgvector
as configured in CI. Do not point them at a live database. See the readiness guide for
wire generation, startup proof, prior-runtime checks and exact CI/image requirements.
The release engine consumes those proofs; local success is not release acceptance.

## Shared work and release boundary

These instructions apply to every agent and contributor. `AGENTS.md` is canonical;
`CLAUDE.md` only imports it. Read this guide, README, relevant nested instructions,
Git status, package/toolchain files and CI before editing. If working from a shared
Daski workspace, explicitly read its root guide, repository map and development
workflow too; a standalone clone must remain usable without private workspace paths.

Use one task branch/worktree and one writer per checkout. Preserve other work.
Identify affected sibling repositories, interface consumers and tests before changing
a shared contract. Keep durable implementation knowledge in tracked docs and private
operational material in its owning private system, not in assistant memory.

Work targets `develop` or a reviewed branch into it. Integration is distinct from
release. The release engine in [daski-io/deploy-mainnet](https://github.com/daski-io/deploy-mainnet)
owns **both sandbox and production**. Read its current `AGENTS.md`,
`docs/release-map.md`, `docs/runbooks/release-engine.md` and handoff schema before an
operation. Never substitute a direct `main`/`sandbox` push or merge, Railway deploy,
package publication or contract broadcast for that process. Even engine `prep` can
sign a catalog epoch or propose a Safe batch; it is not an unsigned local check.
A build request does not authorize release, paid tests, signing or business actions.
Use existing owner authorization within its scope and honor the engine's actual stops.

Keep secrets, customer data, private audits and raw operational logs out of commits.
Never add AI attribution or co-author trailers to commits or pull requests.
