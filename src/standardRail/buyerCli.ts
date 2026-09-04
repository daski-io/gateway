/**
 * The buyer CLI release this gateway's setup guide pins. One value, published
 * machine-readably in /.well-known/mcp.json so `daski doctor` can compare its
 * own version against it, and asserted equal to the prose in skills/setup.md
 * by test so the two cannot drift. A 0.1.0 install went unnoticed on
 * 2026-09-04 because the pin lived only in prose the agent had to compare by
 * eye.
 */
export const PINNED_BUYER_CLI = {
  package: "@daski/pay",
  version: "0.3.0",
  repository: "git+https://github.com/daski-io/buyer.git",
  /** Verifies the registry entry is Daski's before anything is installed. */
  verify: "npm view @daski/pay@0.3.0 repository.url",
  install: "npm install -g @daski/pay@0.3.0",
} as const;
