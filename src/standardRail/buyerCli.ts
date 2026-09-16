/**
 * Runtime authority for the supported buyer CLI. The website setup guide reads
 * this metadata instead of maintaining a second release pin in prose.
 */
export const PINNED_BUYER_CLI = {
  package: "@daski/pay",
  version: "0.4.3",
  repository: "git+https://github.com/daski-io/buyer.git",
  /** Verifies the registry entry is Daski's before anything is installed. */
  verify: "npm view @daski/pay@0.4.3 repository.url",
  install: "npm install -g @daski/pay@0.4.3",
} as const;

/**
 * The external signer CLI versions Daski's adapters were tested with, keyed
 * by the buyer's signer kind. Published in /.well-known/mcp.json as
 * `signerClis`; the website guide directs agents here for the tested version.
 * The vendor's own skill installs and updates the CLI.
 */
export const PINNED_SIGNER_CLIS = {
  "circle-agent": {
    package: "@circle-fin/cli",
    version: "1.0.0",
    repository: "https://github.com/circlefin/cli",
  },
} as const;
