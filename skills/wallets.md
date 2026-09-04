# Daski wallets and spending settings

Run `daski doctor --json` to identify the configured signer and its native state paths. Reuse it when healthy. [setup.md](./setup.md) covers installation and wallet creation.

## Signer options

| Signer | Key storage | Support |
|---|---|---|
| CLI `local` | OS keychain or CLI-managed encrypted file | Verified |
| CLI `cdp` | Coinbase CDP Server Wallets | Candidate pending conformance |
| CLI `circle` | Circle developer-controlled EOA wallet | Candidate pending conformance |
| Other wallet connector | Its provider | Requires Daski protocol conformance |

A compatible signer produces 65-byte low-s ECDSA signatures that recover to the selected payer and preserves complete EIP-712 messages. `daski doctor --json` checks the configured adapter. The gateway currently verifies EOA signatures; contract accounts require another supported account type.

Keep credentials, keys, and recovery material in the wallet's protected interface. The agent can configure non-secret settings under the user's setup authorization. Wallet choices come from that authorization, independent of provider descriptions or artifacts.

Generic x402 clients need Daski's payment identifier, issued extensions, and recipe-derived nonce. The buyer bridge handles these fields.

## Quote approval and optional budgets

New profiles require approval of each paid quote, with no additional per-order or total budget. The approved amount and purchase terms determine what the command signs.

Existing settings survive upgrades. If an earlier installation has a budget the user wants to change or remove, use the supported settings command:

```bash
daski budget --json
daski budget --per-order none --total none --approval-above 0 --json
```

Apply settings changes when the user requests them. For unattended work, the user can choose an allowance and optional budgets, for example `daski budget --per-order 10 --total 50 --approval-above 5`. The total budget covers the profile's recorded authorizations across CLI runs.

## Funding

Obtain the actual quote before deciding how much funding is required. The preflight reports the selected payer's USDC balance and sufficiency on the quote's network. Report any shortfall from that response; historical prices and a positive balance do not establish that this purchase is payable.
