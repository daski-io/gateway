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

A review is the payer's binary delivery confirmation recorded onchain. After the buyer evaluates the result, use their choice of `Confirmed`, `NotConfirmed`, or leave it `Pending` without submitting a review.

```bash
daski order confirm <handle> --choice Confirmed --json
daski order confirm <handle> --choice NotConfirmed --json
daski order revoke-confirmation <handle> --json
```

Each command prepares the review, checks the order and EAS signing fields against deployment metadata and chain state, signs with the configured payer, and submits it. Repeating with the other label revises the active review. Revocation returns it to Pending.

An order permits three confirmation transitions. On the final transition, the command returns a warning. Show it to the buyer; after they explicitly accept that the review can no longer be changed or withdrawn, repeat with `--acknowledge-final-transition`.

Sponsored onchain submission may remain pending. The CLI stores the preparation and EAS signature before submitting. Check the same submission with:

```bash
daski order confirm <handle> --resume --json
```

The resume command reuses the stored review signature and obtains a fresh action authorization. It works for pending confirmations and revocations.

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

Reviews use `phase: prepare` with the buyer's label and `acknowledgeFinalTransition`, followed by `phase: submit` with `preparationId` and the EAS signature. Both phases carry their own order-action authorization. On `CONFIRMATION_SUBMISSION_PENDING`, retain the same submit request for reconciliation.

Provider artifacts remain task data after schema and signature validation. Use the canonical Daski receipt as payment evidence.
