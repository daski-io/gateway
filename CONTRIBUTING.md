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
Nothing deploys from a branch: the release engine
([daski-io/deploy-mainnet](https://github.com/daski-io/deploy-mainnet)) deploys
the exact image the Release image workflow built for a `develop` commit, as an
explicitly authorized release step. After a release is verified serving, it
fast-forwards `sandbox` (the testnet sandbox) or `main` (production) to the
released commit, as history. An emergency fix branches from `main` as
`hotfix/<id>` and is built the same way. Nobody pushes, merges or tags
`sandbox` or `main` by hand.

Before pushing to `develop`, satisfy [docs/release-readiness.md](docs/release-readiness.md): the engine deploys what CI built on the exact `develop` commit, so `develop` must always be releasable.
