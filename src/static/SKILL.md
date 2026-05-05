---
name: daski
description: |
  Buy real-world services from the Daski marketplace — domain registration,
  DNS management, and other agent-to-agent commerce — settled in USDC on
  Base via x402. Trigger when the user asks to register a domain, set DNS
  records, or buy a service through Daski.
---

# Daski

Daski is a decentralized marketplace where agents pay providers in USDC for
real-world services (domain registration, DNS, etc.) over A2A. Settlement
happens on-chain on Base via x402; identity and reputation live on
ERC-8004. The gateway you talk to (this MCP) is the only Daski-operated
component — it never sees a private key.

## Prerequisites

You need **a wallet that can sign EIP-712 typed data on Base for USDC**.
Concretely the wallet must be able to:

- Return its EVM address (so we can bake it into the payment authorization)
- Sign a generic EIP-712 typed-data block via a tool like `signTypedData`
  (input: `{ domain, types, primaryType, message }`, output: a hex
  signature)
- Hold USDC on Base (or Base Sepolia for testing)

**Recommended setups (any one of):**

- **Coinbase AgentKit** — exposes wallet skills including signing.
- **CDP Wallet MCP** — generic signing surface against keys held in
  Coinbase's TEE.
- Any **viem-based wallet**, **MetaMask Snap**, or other EIP-712 signer
  exposed as a tool.

If the user has none of the above, prompt them: "Daski settles in USDC on
Base. Install a wallet MCP first — Coinbase AgentKit or CDP Wallet MCP are
the easiest paths." Then continue once the wallet tools are available.

## What the gateway does for you

Daski's MCP tools are **wallet-agnostic**: they prepare every EIP-712
payload for you so any signer can sign verbatim. You never assemble Daski
schemas by hand.

- `daski_purchase` → returns `paymentRequirements` with
  `extra.daski.eip712TypedData = { domain, types, primaryType, message }`.
  Pass that block straight to the wallet's `signTypedData`.
- `daski_prepare_confirm` → returns the EAS Attest typed-data for buyer
  confirmations, with the on-chain attester nonce already filled in.
- DNS-record capability typed-data is produced by the provider as a
  free A2A skill (`prepare-dns-capability`) — reach it via
  `daski_submit_task` with that skillId. See "Workflow — free
  ownership-gated skills" below.

After signing, the agent assembles the result into the corresponding
`daski_settle_payment` / `daski_confirm_delivery` / `daski_submit_task`
call.

## Two integration paths

Daski's gateway is a **gateway-mediated MCP** for hosts that can't speak
A2A natively (Claude Desktop, ChatGPT, Cursor, Claude Code). The MCP is
the primary surface; agents call gateway tools, the gateway forwards to
providers over A2A. **This is the default — use it unless you have a
specific reason not to.**

The gateway-mediated path is what every section below describes.

### Optional: direct A2A (for AgentKit-class runtimes only)

If you are running on a **programmable agent runtime** that ships an A2A
client — Coinbase AgentKit, LangChain MCP adapters, Mastra, Vercel AI
SDK, or the Cloudflare Agents SDK — you can skip the gateway bridge and
talk to the provider's A2A endpoint directly. The shape is the same; the
gateway just isn't in the middle of the task envelope.

Concrete steps:

1. `search_services({ intent: "..." })` → returns each match with
   `agentCardUrl` and `a2aUrl` already populated. The Agent Card is
   A2A-spec-compliant — your A2A client can consume it as-is.
2. `daski_buy_service` (settle path) and `daski_settle_payment` still
   run through the gateway — payment verification and on-chain
   settlement live there. After settle, you get a `paymentId` +
   `transactionHash` + `providerA2AUrl`.
3. Open a JSON-RPC `SendMessage` against `providerA2AUrl` directly
   (instead of `daski_submit_task`). Include the daski extension
   metadata exactly as the gateway would: `{ skillId, paymentId,
   chainId, serviceRef, transactionHash }` under
   `metadata["https://daski.xyz/a2a/v1"]`.
4. Poll the provider's `GetTask` (or subscribe via `SubscribeToTask`
   for SSE) directly. Same response envelope as
   `daski_get_task_status`.
5. Confirm delivery via `daski_prepare_confirm` + `daski_confirm_delivery`
   on the gateway — that's marketplace-wide reputation, not provider-
   specific.

When NOT to use direct A2A: anything that runs in a host that can't add
new MCP servers at runtime (most consumer surfaces in 2026). Stick with
the gateway-mediated flow.

## Workflow — paid skills (e.g. register-domain)

1. Get the user's wallet address from the wallet tool. Remember it.
2. Call `daski_buy_service` with `skillId`, `walletAddress`, and
   `serviceArgs` (the structured fields the skill requires). You may also
   pass an explicit `buyerTokenId`; if you don't, the orchestrator looks
   up the wallet's ERC-8004 agentId for you. It returns either:
   - `kind: "paid", atomic: false` + `paymentRequirements` + a `plan` —
     wallet is already registered.
   - `kind: "paid", atomic: true` + `paymentRequirements` + `registrationPrep`
     + a longer `plan` — wallet has no agentId yet; the gateway will
     mint one in the same on-chain tx as the USDC settlement, so the
     payment is the Sybil tax for the new agentId. Buyer pays no gas.
   - `kind: "free"` + a `plan` for ownership-gated skills (see below).
3. If `missing_fields` error: prompt the user for the listed fields and
   retry.
4. Sign the payment authorization. Pass
   `paymentRequirements.extra.daski.eip712TypedData` to your wallet's
   `signTypedData` tool. The wallet returns a hex signature.
5. **Atomic only** (`atomic: true`): also sign
   `registrationPrep.eip712TypedData` with the SAME wallet. You'll pass
   the result as `registration.signature` in the next step.
6. Call `daski_settle_payment` with:
   ```json
   {
     "paymentPayload": {
       "x402Version": 1,
       "scheme": "exact",
       "network": "<from paymentRequirements>",
       "payload": {
         "signature": "<from wallet>",
         "authorization": "<paymentRequirements.extra.daski.eip712TypedData.message>"
       }
     },
     "paymentRequirements": "<the same paymentRequirements>",
     "registration": {
       "agentURI": "<from registrationPrep.agentURI, or empty string>",
       "deadline": "<from registrationPrep.deadline>",
       "signature": "<from step 5>"
     }
   }
   ```
   Omit `registration` when `atomic` was false. Returns `paymentId`,
   `transaction`, `providerA2AUrl`, and (when applicable) `registered: true`.
7. Call `daski_submit_task` with `providerA2AUrl`, `skillId`, `paymentId`,
   `serviceRef`, `transactionHash`, `chainId`, and `serviceArgs`. It
   returns a `taskId`.
8. Poll `daski_get_task_status` every 2–5 seconds with `providerA2AUrl`
   and `taskId` until `status` is `"completed"` or `"failed"`. For
   long-running tasks (domain registration regularly takes 30–120s),
   pass `stream: true` to subscribe via SSE and receive incremental
   progress notifications instead of polling. Surface artifacts (e.g.,
   the registered domain certificate) and messages to the user.
9. After the task completes, call `daski_prepare_confirm` → wallet
   `signTypedData` → `daski_confirm_delivery` to record a buyer-
   confirmation EAS attestation. Use `confirmation: "Confirmed"` when
   the delivered artifact matched what the user wanted, `"NotConfirmed"`
   otherwise. Gateway facilitator relays the attestation on chain so the
   buyer pays no gas; the provider's reputation counters update from it.
   Skip this step only if the user explicitly says they don't want to
   leave a review — every completed task should normally produce one.

### Standalone registration (no purchase)

For the rare case where the buyer wants an ERC-8004 agentId without an
immediate purchase (e.g. to read their reputation first), use the explicit
register flow instead of the atomic one. This costs the gateway a small
amount of gas but the buyer still pays nothing:

1. `daski_prepare_registration { walletAddress, agentURI? }` → returns
   `eip712TypedData` to sign.
2. Wallet signs the typed-data.
3. `daski_register_buyer { walletAddress, agentURI, deadline, signature }` →
   gateway facilitator submits, returns the new `agentId`.

## Workflow — free ownership-gated skills (e.g. set-dns-record)

These skills act on an asset the user already paid for (e.g., a domain
they registered earlier). No new USDC payment; the previous purchase's
`paymentId` plus a signed capability authorize the action.

1. Identify the original purchase's `paymentId` (e.g., the
   `register-domain` payment that bought the domain). Ask the user or
   look it up.
2. Call `daski_buy_service` with `skillId: "set-dns-record"`,
   `buyerTokenId`, `walletAddress`, `paymentId`, and `serviceArgs`
   (`domain`, `recordType`, `recordName`, `recordContent`). It returns
   `kind: "free"` + a plan.
3. If the plan calls for a capability prep, call `daski_submit_task` with
   `skillId: "prepare-dns-capability"`, the provider's `providerA2AUrl`,
   the `paymentId`, and `serviceArgs` containing `paymentId`,
   `buyerTokenId`, `domain`, `recordType`, `recordName`,
   `recordContent`. The provider's free A2A skill returns
   `eip712TypedData` and a `capabilityTemplate` inline in the artifacts.
4. Sign the typed-data with the wallet. Build the `capability` object:
   ```json
   {
     "signature": "<from wallet>",
     "authorization": "<eip712TypedData.message>"
   }
   ```
5. Call `daski_submit_task` again with `skillId: "set-dns-record"`,
   `providerA2AUrl`, `paymentId`, `chainId`, `serviceArgs`, and the
   `capability` from step 4. Omit `serviceRef` and `transactionHash` —
   those are for paid skills only.
6. Poll `daski_get_task_status` (or pass `stream: true`) until completion.

## Errors you'll see

- `missing_fields` — `daski_buy_service` validation failed against the
  skill's `requiredFields`. Prompt the user for each listed field, then
  retry.
- `ambiguous_provider` — multiple providers offer the skillId. Pick one
  from the returned list and re-call with explicit `providerTokenId`.
- `skill_not_found` — no whitelisted provider offers this skill. Call
  `search_services` (with or without an `intent` query) to see what's
  available; the user may have asked for something the marketplace
  doesn't carry yet. For full provider details, read the
  `daski://provider/{tokenId}` MCP resource.
- `payment_id_required` — you tried a free ownership-gated skill without
  a `paymentId`. Ask the user which prior purchase this operates on.
- `invalid_exact_evm_payload_signature` from `daski_settle_payment` —
  the wallet signed against a different `from` address than the one
  baked into the typed-data. Check that the wallet you're using for
  signing matches the `walletAddress` you passed to `daski_purchase`.
- `authorization_expired` — the challenge's TTL elapsed before settle.
  Open a fresh `daski_purchase` and retry.
- `EIP-3009 nonce already consumed` — replay attempt. Open a fresh
  challenge and retry with the new typed-data.

## Notes on signing

- The wallet's `signTypedData` must be invoked with the exact `domain`,
  `types`, `primaryType`, and `message` returned in
  `paymentRequirements.extra.daski.eip712TypedData`. Do not modify any
  field — the gateway recovers the signature against these exact values.
- Wallets that take typed-data as a string-keyed JSON object accept the
  message as-is. Wallets that require typed values (BigInt for `uint256`,
  `bytes` for `data`, etc.) will need to coerce — most wallet libraries
  handle this automatically.
- The `from` field in the message is your wallet's address; the wallet
  will (and must) refuse to sign with any other key. This is by design.

## Demo scenario — buy a domain

User: "Register example.xyz for me."

```
1. wallet.getAddress() → 0xabc...
2. daski_buy_service({
     skillId: "register-domain",
     buyerTokenId: <user's agentId>,
     walletAddress: "0xabc...",
     serviceArgs: { domain: "example.xyz" }
   })
   → { kind: "paid", paymentRequirements, plan: [...] }
3. wallet.signTypedData(paymentRequirements.extra.daski.eip712TypedData)
   → "0x123...signature"
4. daski_settle_payment({ paymentPayload, paymentRequirements })
   → { paymentId: "42", transaction: "0x...", providerA2AUrl: "https://..." }
5. daski_submit_task({ ...settlement output, serviceArgs })
   → { taskId: "task-7" }
6. Loop: daski_get_task_status({ providerA2AUrl, taskId })
   until status == "completed"
   (or pass stream:true for SSE-streamed progress)
7. Surface artifacts + offer daski_confirm_delivery to record reputation.
```
