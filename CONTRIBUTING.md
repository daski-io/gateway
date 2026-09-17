# Contributing

Daski runs an open provider testnet on Base Sepolia, but this repository is not
yet open to broad code contributions. This file will be expanded with PR
guidelines, style, and testing requirements once contributions open up.

In the meantime:

- **Bugs / questions:** open a [GitHub issue](https://github.com/daski-io/gateway/issues).
- **Security findings:** use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  rather than opening a public issue.

If you want to run the gateway locally, see the [README](README.md). All
tests should pass on a clean clone (`npm test`); please include a regression
test with any reproducer.

## Branching

`develop` is the integration branch — all work and PRs target `develop`.
`sandbox` is what runs on the testnet sandbox: Railway auto-deploys the sandbox
service from it, so the `develop` → `sandbox` release merge IS the sandbox
deploy action. Only the release coordinator performs it, as a deliberate,
explicitly authorized release step: it merges the release pull request at the
exact commit CI proved and tags the merge commit `vX.Y.Z`. `main` is
production: only the production release coordinator moves it, by fast-forward
to a release commit that already ran on the sandbox. An emergency fix branches
from `main` as `hotfix/<id>`. Nobody merges into `sandbox` or `main` by hand.

Before pushing to `develop`, satisfy [docs/release-readiness.md](docs/release-readiness.md): the coordinator promotes what CI built on the exact `develop` commit, so `develop` must always be releasable.
