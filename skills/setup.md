# Set up Daski

Daski lets agents discover and buy real-world services. Use the configured signer; key material stays in its protected store. Load this guide and [buy.md](./buy.md) in full through `daski_get_setup_guide` or a raw fetch before the first purchase.

## Check existing setup

Run `daski doctor --json` if the CLI is available. Compare `cliVersion` with `buyerCli.version` in `/.well-known/mcp.json`. Install or upgrade when needed, then run doctor again before choosing a signer. An absent CLI on PATH does not establish that a wallet is missing.

Use doctor's `stateDirectory`, `configFile`, signer, and self-test results. These paths come from the CLI's native home directory or `DASKI_HOME`; a shell's `~` can point elsewhere. Reuse a healthy signer. A missing local key is not a reason to create one; choose the signer below. Doctor may report an empty balance while the signer is healthy; the purchase quote determines how much funding is needed.

## Choose the signer

The default is the Circle agent wallet, on every kind of host. The user owns it through their email, no key sits on the agent's machine, and it signs everything Daski asks for. Use it whenever `payerAccounts.types` in `/.well-known/mcp.json` includes `contract`.

Use another signer only when the user asks for one:

- A local key, only on the user's own durable machine. It cannot be recovered if that machine or its key store is lost.
- Another wallet from the table in [wallets.md](./wallets.md), which also says which wallets cannot buy on Daski and why.

If `payerAccounts.types` lacks `contract`, that gateway accepts plain wallets only. On the user's own machine use a local key; anywhere else stop and tell the user that this gateway has not enabled contract wallets yet.

## Circle agent wallet

1. Install exactly the pinned version from `/.well-known/mcp.json` (`signerClis.circle-agent`); the pin is the provenance, the package publishes no repository metadata to compare: `npm install -g @circle-fin/cli@<pinned>`
2. Show Circle's Terms of Use and Privacy Policy links and obtain the user's explicit consent, then run `circle terms accept`. Never set `CIRCLE_ACCEPT_TERMS` yourself.
3. Log in with the user's email: `circle wallet login <email> --type agent --init`. Ask the user for the 6-digit code from their inbox, then run `circle wallet login --type agent --request <id> --otp <code>`.
4. List wallets and create one only if none exists: `circle wallet list --chain <BASE|BASE-SEPOLIA> --type agent --output json`, then `circle wallet create --output json`.
5. The wallet must be deployed before its first purchase. If doctor reports `DASKI_SIGNER_NOT_DEPLOYED`, send a zero-value transfer from the wallet to itself with the circle CLI and run doctor again.
6. Fund it. Sandbox: `circle wallet fund --address <addr> --chain BASE-SEPOLIA --token usdc`. Mainnet: `circle wallet fund ... --method fiat --open`, or `--method crypto --open`.
7. Spending limits are set by the user in their own terminal (`circle wallet limit set ...`). Do not relay the code for that step.
8. Configure Daski: set `DASKI_KEY_BACKEND=circle-agent`, run `daski doctor --json --signer circle-agent`, and set the profile's `signer` to `circle-agent` in `configFile`.

## Local key (durable machine only)

Set `DASKI_HOST_CLASS=durable` on the user's own machine (`ephemeral` anywhere else; the CLI refuses a local key there) and `DASKI_KEY_BACKEND=file` (or `keychain` on macOS and Windows). Without a terminal, provide `DASKI_KEYSTORE_PASSPHRASE_FILE`. Then run `daski wallet create --yes-human-approved` after the user authorizes it.

## Before the first paid purchase

`daski doctor --json` must report no blocking issue, `keyDurability` other than `session-memory`, and `deployed: true` for a contract signer. Record for the user: payer address, order handle, payment identifier, signer kind.

## Install or upgrade

The pinned release is `@daski/pay@0.4.1`. Verify its registry provenance:

```bash
npm view @daski/pay@0.4.1 repository.url
```

The expected repository is `git+https://github.com/daski-io/buyer.git`. When the package version and repository match, use the user's setup authorization:

```bash
npm install -g @daski/pay@0.4.1
daski doctor --json
```

If the pinned package is unavailable, report that release dependency. Upgrades retain existing wallet keys and spending settings. New profiles approve each paid quote and have no additional default budget. See [wallets.md](./wallets.md) for optional budgets and hosted signers.

The pinned Circle agent wallet CLI is `@circle-fin/cli@1.0.0` from `https://github.com/circlefin/cli`; the same pin is published as `signerClis.circle-agent` in `/.well-known/mcp.json`.

## Connect the marketplace

Use the gateway MCP URL published in `/.well-known/mcp.json` in the client's MCP configuration. Reuse an existing connection. Discovery and purchases use gateway tools or REST; provider URLs in catalog data identify the provider and its terms.

## Complete the first purchase

1. Discover the matching outcome with `daski_list_outcomes` and `daski_get_outcome`.
2. Build the request from details already supplied. Normalize unambiguous names, abbreviations, and schema constants: for example, Wyoming becomes `WY`, and the ordinary LLC request uses its canonical catalog label. Call `daski_get_outcome_requirements` with the known partial request to obtain the published schema, conditional requirements, and missing fields. Reuse `normalizedSelectors`. Ask together for missing personal details and meaningful business choices. Preserve the user's selected people and roles.
3. Save the completed request as JSON and run `daski buy --provider <id> --outcome <id> --request <file.json> --json`. The CLI uses `daski_get_payment_challenge` to obtain the actual quote and balance preflight. This shares the request with the provider for pricing and creates or reuses a draft; payment follows approval.
4. Present the actual service, provider, request, price, network, payer, and terms from the quote. If funding is insufficient, report the quoted requirement, balance, shortfall, payer address, and network. Once the user approves the purchase and it is payable, repeat the command with `--approve <approval.id>`. Interactive CLI use prompts directly.
5. Keep the returned order handle and payment identifier. Follow [orders.md](./orders.md) for status, input, and artifacts.

The approval identifier binds the amount and purchase terms. It remains valid across quote expiry when those terms are unchanged; a changed quote returns a new approval identifier. Follow recoverable errors in [buy.md](./buy.md#errors) and continue.

Carry the requested purchase through setup, intake, quotation, payment, and tracking. Reuse details and authorization already supplied for this task. Keep progress messages focused on the requested outcome and the next useful action.

Once setup is complete: **Use Daski to [your task].**
