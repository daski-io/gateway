#!/usr/bin/env bash
# Prior-runtime compatibility proof for migration changes. A rollback, and the
# old instance during a deploy, run the previous runtime on the schema this
# candidate migrated, so that runtime must still boot on it. Builds <base> in a
# temporary worktree and boots its compiled runtime through the startup proof
# on a disposable database the candidate's complete migrations prepared.
#
#   bash scripts/reliability/prior-runtime.sh <base sha> [evidence path]
#
# Run from the repository root after `npm run build`, with DATABASE_URL_TEST
# naming a disposable loopback PostgreSQL, as `npm run test:startup` requires.
set -euo pipefail
candidate="$(pwd)"
base="${1:?supply the exact prior Git SHA}"
base="$(git rev-parse --verify --end-of-options "$base^{commit}")"
prior="$(mktemp -d "${TMPDIR:-/tmp}/gateway-prior-runtime.XXXXXXXX")"
cleanup() {
  git -C "$candidate" worktree remove --force "$prior" 2>/dev/null || { rm -rf "$prior"; git -C "$candidate" worktree prune; }
}
trap cleanup EXIT
git worktree add --detach "$prior" "$base"
# The prior build identifies itself by its own checkout, never by a SOURCE_SHA
# exported for the candidate.
(cd "$prior" && env -u SOURCE_SHA npm ci --no-audit --no-fund && env -u SOURCE_SHA npm run build)
npm run test:startup -- --prior-root "$prior" --output "${2:-gateway-prior-runtime-evidence.json}"
