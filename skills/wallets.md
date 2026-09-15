# Daski wallets and spending settings

Run `daski doctor --json` to identify the configured signer and its native state paths. Reuse it when healthy. [setup.md](./setup.md) covers installation and wallet creation; the Circle agent wallet is the default on every host.

## Signer options

| Signer | Account | Status | Buys | Tracks | Confirms delivery | Gas for confirmation |
|---|---|---|---|---|---|---|
| Circle agent wallet | contract | candidate until its conformance run is recorded | yes | yes | direct, through the circle CLI | Circle sponsors, capped |
| Local key | EOA | verified | yes | yes | sponsored by Daski | none |
| CDP server wallet | EOA | candidate | yes | yes | sponsored by Daski | none |
| Base Account via Base MCP | contract | candidate | via MCP | via MCP | direct, via Base MCP | account pays |

Contract wallets must be deployed before the first purchase. Keys and one-time codes never pass through the agent except the Circle login code the user chooses to share. Doctor reports a candidate signer as such; it can still buy.

## Any other wallet

A wallet can pay on Daski when it signs arbitrary EIP-712 typed data (the payment, every order action, and the delivery review) and its account is a plain wallet or a deployed contract account. The CLI wires in the signers above; a wallet outside the table needs an adapter first, however capable. Wallets that cannot sign typed data cannot buy at all: Coinbase Agentic Wallet and Payments MCP only pay stock x402 requests, so they can neither pay a Daski quote nor track the order afterwards. Wallets an operator provisions for an end user (Privy, Crossmint, Turnkey, Para) need Daski to hold the provider account, which Daski does not do.

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
