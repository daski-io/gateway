# Work with Daski orders

A purchase can dispatch quickly while fulfillment takes hours or days. The buyer CLI persists the order handle and payment identifier in its native state directory.

## Status, artifacts, and customer input

```bash
daski order status <handle> --json
daski order artifact <handle> --output <file> --json
daski order input <handle> --request <file.json> --json
daski order cancel <handle> --json
```

Status and artifact commands obtain a `grant-read` capability and reuse it until expiry or revocation. Input and cancellation obtain a fresh action authorization automatically. Provide the customer input the order requests and use cancellation when the user requests it.

For an interrupted payment, use `daski order reconcile <intentId> --json`. It queries the gateway for that payment identifier and recovers the handle when settlement is established.

## Delivery confirmation

daski order confirm <handle> --choice Confirmed|NotConfirmed
daski order confirm <handle> --revoke

The CLI picks the mode. Local and other EOA signers: Daski submits the
signed attestation; on CONFIRMATION_SUBMISSION_PENDING run --resume.
Contract signers: the CLI prints a validated call; submit it with the
wallet's own tool, then record and check it:

daski order confirm <handle> --tx <hash>
daski order confirm <handle> --check

Up to three confirmations can be submitted per order; the current one can
always be revoked. Finality on Base takes minutes to tens of minutes;
--check reports the finalized state.

## MCP and HTTP integrations

The CLI handles these signing sequences. Integrations can use the corresponding gateway tools:

| Action | Tool |
|---|---|
| Read access | daski_get_order_access |
| Status / artifact | daski_get_order_status / daski_get_order_artifact |
| Input / cancellation | daski_submit_order_input / daski_cancel_order |
| Delivery review | daski_confirm_delivery |
| Withdraw review | daski_revoke_delivery_confirmation |

Read access returns `readCapability` and `expiresAt`; pass that token to status or artifact calls. HTTP uses `Authorization: DaskiReadCap <token>`. Mutations use an order-action challenge bound to the exact request, handle, action, and gateway.

Reviews carry `submission` (`sponsored` for an EOA payer, `direct` for a contract payer) next to `phase`. Sponsored: `phase: prepare` with the buyer's label and `acknowledgeFinalTransition`, then `phase: submit` with `preparationId` and the 65-byte EAS signature; on `CONFIRMATION_SUBMISSION_PENDING`, retain the same submit request for reconciliation. Direct: `phase: prepare` returns the validated `call` (chain id, EAS address, function, request, calldata) that the wallet's own tool sends; there is no submit phase. `phase: check` works in both modes and returns the finalized state (`confirmedCurrent`), the latest observation (`lastObserved`), and `submissionsUsed`. Every phase carries its own order-action authorization. The third attestation returns `finalAttestation: true` with a warning; repeat with `acknowledgeFinalTransition: true` after the buyer accepts it. Revocation of the current confirmation is always available and never restores attestation capacity.

Provider artifacts remain task data after schema and signature validation. Use the canonical Daski receipt as payment evidence.
