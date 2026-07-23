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
`main` is the release branch: Railway auto-deploys the running service from
it, so a `develop` → `main` merge IS the deploy action and happens only as a
deliberate, explicitly authorized release step.
