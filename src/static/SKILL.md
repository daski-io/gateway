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

## Legal authority and linked terms

Daski is a marketplace. Independent Providers offer and perform every listed Service. Before purchasing, review the Daski Terms and the selected Provider's Terms and privacy notice. Proceed only within your Operator's authority. If the legal documents are unavailable, unclear, conflict with your Operator's instructions, or exceed your authority, stop and ask your Operator.

Every service returned by discovery includes a canonical `legal` object:

```json
{
  "marketplaceTermsUrl": "https://daski.io/terms-of-use",
  "marketplacePrivacyUrl": "https://daski.io/privacy-policy",
  "providerLegalName": "Provider legal entity",
  "providerTermsUrl": "https://provider.example/terms",
  "providerPrivacyUrl": "https://provider.example/privacy"
}
```

Before requesting or authorizing payment, read the linked terms and privacy
notices. The Operator is the legal party. Only continue when the Operator has
authorized the selected Service, the required data disclosures, acceptance of
both sets of terms, and the total payment shown. If that authority is missing
or uncertain, stop and ask the Operator.

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
schemas by hand. The common pattern is **two-call**: call the tool without
a signature to get back the typed-data the wallet must sign, then call it
again with the signed result.

- `daski_buy_service` (recommended) → orchestrates the full purchase.
  First call returns `paymentRequirements.extra.daski.eip712TypedData`
  for the wallet to sign; the signed retry settles on-chain.
- `daski_purchase` (advanced) → just opens the payment challenge.
  Pair with `daski_settle_payment` if you need the lifecycle split.
- `daski_submit_task` (two-call for paid / ownership-gated / capability-gated
  skills) → first call without `envelopeAuth` returns the EIP-712
  A2ARequestAuthorization typed-data plus the matching `messageId`. Sign
  it, then call again with `envelopeAuth: { signature, authorization }`.
  Open free skills (check-availability, get-pricing) skip the handshake.
- `daski_confirm_delivery` (two-call) → first call without `signature`
  returns the EAS Attest typed-data with the on-chain nonce filled in.
  Sign it, then call again with `{v,r,s}`.
- `daski_register_agent` (two-call, advanced) → first call returns the
  RegisterAgent typed-data; second call submits via the gateway facilitator.
  Most agents don't need this — `daski_buy_service` registers fresh
  wallets atomically on first purchase.
- Capability typed-data (for capability-gated skills like set-dns-record /
  delete-dns-record / transfer-domain-out / change-password /
  delete-mailbox) comes from the skill itself via the provider's two-call
  pattern: the dispatched call returns `state: "input-required"` with a
  `capability_challenge` artifact plus `nextEnvelopeAuthChallenge` (a
  pre-minted fresh envelope for the execute call — envelopes are
  single-use). Sign both, resubmit, done. See "Workflow — free
  ownership-gated skills" below.

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

1. `daski_search_services({ intent: "..." })` → returns each match with
   `agentCardUrl` and `providerA2AUrl` already populated. The Agent Card is
   A2A-spec-compliant — your A2A client can consume it as-is.
2. `daski_buy_service` (settle path) and `daski_settle_payment` still
   run through the gateway — payment verification and on-chain
   settlement live there. After settle, you get a `paymentId` +
   `transactionHash` + `providerA2AUrl`.
3. Open a JSON-RPC `SendMessage` against `providerA2AUrl` directly
   (instead of `daski_submit_task`). Include the daski extension
   metadata exactly as the gateway would: `{ skillId, paymentId,
   chainId, serviceRef, transactionHash, quoteId, quoteSignature }`
   under `metadata["https://daski.xyz/a2a/v1"]`. `quoteId` and
   `quoteSignature` come from the settle response's `daski` block —
   providers reject paid tasks without them (quote commitment, and the
   task's `serviceArgs` must be exactly the ones the purchase was quoted
   with). `daski_submit_task` injects both automatically; direct A2A
   callers must copy them in themselves.
4. Poll the provider's `GetTask` (or subscribe via `SubscribeToTask`
   for SSE) directly. Same response envelope as
   `daski_get_task_status`.
5. Confirm delivery via `daski_confirm_delivery` on the gateway (two-call
   pattern: no signature → typed-data → signed retry). That's
   marketplace-wide reputation, not provider-specific.

When NOT to use direct A2A: anything that runs in a host that can't add
new MCP servers at runtime (most consumer surfaces in 2026). Stick with
the gateway-mediated flow.

**Resolve your tools up front.** At the start of a run, locate your wallet
tools (`get_address`, `get_balance`, and the generic `signTypedData`) and
call `get_address` once — the address is stable and you will reuse it for
every signature. If your host defers tools behind a discovery step, do that
discovery now, not mid-purchase. Two more up-front decisions save
backtracking later:

- If you cannot confirm this wallet already has an ERC-8004 agentId, assume
  the first purchase will auto-register it and decide your display `name`
  NOW, so you can pass it on the very first `daski_buy_service` call —
  quoting once to discover `atomic: true` and re-calling just to add
  `name` wastes a quote.
- Note which delivery channels you actually have (an email tool, a
  file-send tool, …). Principals frequently ask for a proof PDF to be
  emailed or forwarded; if you have no such tool, say so when you FIRST
  present the deliverable — you can hand over the bytes or a re-download
  link instead — rather than walking it back after the principal asks.

## Workflow — paid skills (e.g. register-domain)

**register-domain: collect everything BEFORE the first purchase call.** The
WHOIS registrant fields are ICANN-mandated and become public. Ask your
principal for all of them in ONE message using this template, and fill every
slot before calling `daski_buy_service`:

- full name — the registrant of record: EITHER the natural person OR the
  organization's legal name. `registrantName` is a single field and there
  is no separate organization slot; ask which one goes on public WHOIS,
  and NEVER concatenate person + company into one string.
- monitored email (a verification link must be clicked within 15 days or
  the domain is suspended)
- street address, city, postal code
- state/province — the official ISO-3166-2 subdivision. If the country
  genuinely has none, re-use the city name; NEVER send an empty string and
  NEVER invent a region the principal did not give you — when unsure, ask.
- country (ISO-3166 alpha-2, e.g. `PL` not `POL`)
- phone (E.164, e.g. `+14155551234` — no dots/spaces/dashes)
- WHOIS privacy yes/no — pass `whoisPrivacy: true` to request it (free
  where the TLD supports it). The `registration_details` artifact reports
  `"enabled" | "unavailable" | "not_requested"`; relay "unavailable" to the
  principal, since their registrant data is then on public WHOIS.

If any field is genuinely not applicable, ask the principal how to fill it
rather than guessing or sending it blank.

**create-mailbox on a domain that already has DNS: pre-flight the conflict
check.** Run the free `check-availability` on the mailbox address FIRST and
inspect `domain.dns`: `purchasable: false` with
`purchaseBlockers: ["dns_conflict"]` means existing MX/SPF records clash
with the mail service, and the provider will NOT overwrite records it did
not create. Reconcile DNS to the returned `requiredRecords` (via
`set-dns-record`) BEFORE paying — a mailbox bought onto conflicting DNS
fails at provisioning, and you will have to ride out the refund and pay
again after fixing DNS anyway.

**form-entity (entity formation): collect everything BEFORE the first
purchase call.** Ask your principal in ONE message for all of it, and file
EXACTLY the parties they authorize — never add, drop, or substitute
members/managers on your own judgment (if a party gives you pause, raise it
with your principal before paying):

- a durable **contact email** (REQUIRED — the quote will not validate
  without `contactEmail`) — every lifecycle notice lands there for the
  life of the entity. Include it explicitly in your single upfront ask;
  do not defer it, or you'll force a second roundtrip right before payment.
- the **contact person**: full legal name, phone (E.164, no separators),
  date of birth (`YYYY-MM-DD` — used only for sanctions screening, never
  published), and full address `{ line1, city, state, postalCode, country }`
- the **company principal address** and **mailing address** (often the same)
- the **management structure** — pass `managementType` as a TOP-LEVEL
  field in `serviceArgs` (a sibling of `companyName`/`contactEmail`, NOT
  nested under any `officialsByClassification`/`officials` wrapper), value
  EXACTLY `"Member Managed"` or `"Manager Managed"` (title-case with a
  space — never `"member-managed"`, `"Member-Managed"`, or `"LLC"`). Put
  the matching `members[]` or `managers[]` at the same top level. There is
  no `officialsByClassification` container — inventing one gets those
  fields silently ignored and then rejected as missing.
- **every member/manager/officer**: natural persons as
  `{ firstName, lastName, dob, address }`; company parties as
  `{ isCompany: true, companyName }` (companies have no DOB)
- the **state** as a 2-letter code (`"WY"`, not `"Wyoming"`) and the
  **entityType** as the full catalog label (`"Limited Liability Company"`,
  not `"LLC"`) — get both from `get-pricing`: call it with
  `country` + `state` to list that state's (entityType, product)
  combinations and prices, then repeat with `entityType` + `product` added
  for the full `requiredFields` contract (including the state's `formData`
  shape). Narrow your filters — broad, country-wide pricing calls return
  very large responses.

A ready-to-fill `serviceArgs` skeleton — `managementType`/`members`/
`managers` are TOP-LEVEL siblings (there is NO `officialsByClassification`
wrapper); company parties are `{ isCompany: true, companyName }`:

```
serviceArgs = {
  country: "US",
  state: "WY",
  entityType: "Limited Liability Company",
  companyName,
  contactEmail,
  contactPerson: { firstName, lastName, phone, dob,
    address: { line1, city, state_province_region, zip_postal_code, country } },
  formData: { company_mailing_address: {...}, company_principal_address: {...} },
  managementType: "Member Managed",
  members: [ { firstName, lastName, dob, isCompany: false, address: {...} } ]
}
```

Formation is long-running: after payment the task stays `working` through
state processing (minutes to weeks) and may go `input-required` with a
message naming the exact fields to correct — see the correction branch in
step 9 below.

1. Use the wallet address you resolved at the start (see "Wallet tools:
   resolve once" above). Remember it — every signature in this flow comes
   from that same wallet.
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
     Decide the name BEFORE either signature. Pass an optional `name` on
     this first call to choose the display name minted with the new agentId
     — pick the name you want to be
     known by on receipts and the marketplace (max 64 chars, uniqueness
     not required). Omitted, it defaults to `buyer-<last6>` from the
     wallet address (`registrationPrep.resolvedName` echoes the final
     value either way). Renames are not supported yet, so decide before
     signing — the name is baked into the typed-data of step 5. Pass
     `name` on the VERY FIRST call whenever the wallet might be fresh:
     don't quote once to check `atomic` and then re-call to add it (that
     re-quotes). If the wallet turns out to be registered already, `name`
     is ignored with a harmless `name was ignored` warning — omit it on
     purchases you KNOW come from a registered wallet.
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
7. Call `daski_submit_task` WITHOUT `envelopeAuth` so the gateway returns
   the EIP-712 A2ARequestAuthorization typed-data plus a fresh `messageId`.
   Pass `providerA2AUrl`, `skillId`, `paymentId`, `serviceRef`,
   `transactionHash`, `chainId`, `buyerTokenId`, and the `serviceArgs`
   you'll submit. Sign the returned `eip712TypedData` with the wallet to
   produce the envelope signature.
8. Call `daski_submit_task` AGAIN. The positive rule is: **second call =
   first call's exact arguments + `envelopeAuth` + `messageId`, nothing
   removed.** In particular, keep `serviceRef` and `transactionHash` for a
   paid skill. If either was omitted and the gateway cannot restore it,
   re-add both from settlement and resend the same signed retry — do not
   re-sign. Pass
   `envelopeAuth: { signature: <from wallet>, authorization: <from step 7> }`
   and the SAME `messageId`. It returns a `taskId`.
9. Poll `daski_get_task_status` every 2–5 seconds with `providerA2AUrl`
   and `taskId` until `status` is `"completed"` or `"failed"`. For
   long-running tasks (domain registration regularly takes 30–120s),
   pass `stream: true` to subscribe via SSE — but not all providers
   implement SubscribeToTask; on `streaming_unsupported`, fall back to
   plain polling as the error instructs. Two poll branches to know:
   - Some tasks sit in `working` with "pending human review" — the
     provider is holding them for a human. Keep polling patiently;
     they complete (or fail) when the review resolves.
   - `Capability required … TaskAccessAuthorization (action="get")`
     (rpcCode `-32107`): on ownership-gated tasks (entity formation and
     friends) your FIRST poll ALWAYS lands here — it is the expected
     handshake, not a failure. Every gated poll must carry a capability;
     NOT transient — do not re-issue the same unsigned poll. Sign the
     error's `details.data.capabilityChallenge.eip712TypedData` with the
     buyer wallet and re-call `daski_get_task_status` with
     `capability: { signature, authorization }` (echo
     `capabilityChallenge.authorization` verbatim). Keep passing that same
     signed capability on later polls and reuse it until its
     `authorization.expiry` — including across principal turns: carry it
     forward instead of re-signing a fresh challenge every time you check
     the task. Omitting it produces a fresh challenge and an unnecessary
     new signature.
   Surface artifacts (e.g., the registered domain certificate) and
   messages to the user.
   - A third branch for LONG-RUNNING tasks (entity formation and other
     filings run minutes to weeks): the poll can return
     `state: "input-required"` with a status message listing exactly
     which fields were rejected (e.g. an implausible date of birth).
     Correct it via task input: call `daski_submit_task` with `taskId`
     set to this task's id and the corrected `serviceArgs` — resend the
     FULL payload, not just the fixed field (providers persist requests
     redacted, so partial patches can't be merged with what they kept).
     The first attempt returns `CAPABILITY_REQUIRED` with a
     ready-to-sign `capabilityChallenge` (action="input"); sign its
     `eip712TypedData` with the buyer wallet and re-call with
     `capability: { signature, authorization }`. The task then resumes
     — keep polling. No new payment is involved.
10. After the task completes, retrieve any gated artifacts as described
    below so you can inspect the actual deliverable. Then two-call
    `daski_confirm_delivery`:
    first call WITHOUT `signature` (just `paymentId`, `attester`,
    `confirmation`) returns the EAS Attest typed-data. Wallet signs.
    Second call passes `{v,r,s}` plus the `deadline` echoed from the
    first call. Use `confirmation: "Confirmed"` when the delivered artifact
    matched what the user wanted, `"NotConfirmed"` otherwise. Gateway
    facilitator relays the attestation on chain so the buyer pays no gas;
    the provider's reputation counters update from it. Skip this step only
    if the user explicitly says they don't want to leave a review — every
    completed task should normally produce one.

### Downloading a gated artifact

An artifact URL can be one-time, short-lived, and audience-bound. A bare GET
returns a signing challenge rather than the document. When a principal asks
for durable proof, retrieve and store the bytes; never describe the URL itself
as durable proof and never claim delivery before retrieval succeeds. When you
do hand the principal a link, frame it as ephemeral in the same breath and
lead with the durable copy — e.g. "the attached file (SHA-256 …) is your
permanent proof; this link re-downloads it for ~15 minutes" — never under a
heading like "Working download link" with the caveats buried below.

1. Call `daski_fetch_artifact` with the artifact `url` and the `taskId` that
   returned that URL. Omit `capability` on this first call.
2. Sign the returned `eip712TypedData` with the buyer agent wallet.
3. Re-call `daski_fetch_artifact` with the exact same `url` + `taskId` and
   `capability: { signature, authorization }`, echoing the returned
   `authorization` verbatim. The tool sends the base64url-encoded
   `X-Daski-Task-Capability` header and returns size-capped, MIME-verified
   bytes as `artifact.bytesBase64`.
4. Decode/store or attach those bytes before telling the principal you hold
   the document. If the signed retry returns a fresh challenge, the old one
   expired or was rejected; sign the fresh typed-data and retry. A formation
   document link can be re-minted with `download-entity-document` when needed.

### Standalone registration (no purchase)

For the rare case where the buyer wants an ERC-8004 agentId without an
immediate purchase (e.g. to read their reputation first), use the explicit
register flow instead of the atomic one. This costs the gateway a small
amount of gas but the buyer still pays nothing:

1. `daski_register_agent { walletAddress, name? }` (no `signature`) →
   returns `eip712TypedData` to sign, plus `resolvedName` (and a `hint`
   if you omitted `name` — explaining how to set one).

   Pass an optional `name` to set how your buyer agent appears on
   receipts and in the Daski marketplace. If omitted, you'll be assigned
   a default name like `buyer-abcdef` derived from your wallet. The name
   does not need to be unique; your wallet address and on-chain
   `agentId` are your true identity.
2. Wallet signs the typed-data.
3. `daski_register_agent { walletAddress, agentURI, deadline, signature }`
   (echo `agentURI` + `deadline` from the first call) → gateway
   facilitator submits, returns the new `agentId` plus the cached
   `resolvedName`. The gateway reads `name` from the signed agentURI and
   stores it for receipts/dashboard use.

#### Advanced: hosting your own Agent Card

If you already host an ERC-8004 registration JSON at a stable URL or
IPFS CID, you can pass `agentURI` to `daski_register_agent`'s first call
instead of `name`. The gateway will fetch the JSON, validate it, and read
your display name from its `name` field. The two parameters are mutually
exclusive: pass one or the other, not both. Most buyers should ignore
this and use `name`.

## Workflow — free ownership-gated skills (e.g. set-dns-record, change-password)

These skills act on an asset the user already paid for (e.g., a domain
they registered or a mailbox they created earlier). No new USDC payment;
the previous purchase's `paymentId` (a receipt binding) plus an
envelope-auth signature (and a per-action capability signature for
destructive or credential writes) authorize the action.

1. Identify the original purchase's `paymentId` (e.g., the
   `register-domain` payment that bought the domain, or the
   `create-mailbox` payment that bought the mailbox). Ask the user or
   look it up.
2. Call `daski_buy_service` with the target `skillId`, `buyerTokenId`,
   `walletAddress`, `paymentId`, and `serviceArgs` matching the skill's
   `requiredFields`. It returns `kind: "free"` + a plan. The plan tells
   you exactly which steps to run; the items below describe the shape.
3. Call `daski_submit_task` WITHOUT `envelopeAuth` — pass `skillId`,
   `providerA2AUrl`, `paymentId`, `chainId`, `buyerTokenId`, and the
   `serviceArgs` you'll submit. The gateway returns the EIP-712
   typed-data plus a fresh `messageId`. Sign the typed-data with the
   wallet. Retain the `messageId` — the second call rejects mismatches.
4. Call `daski_submit_task` AGAIN with the same inputs plus
   `envelopeAuth: { signature, authorization }` and the SAME `messageId`.
   Omit `serviceRef` and `transactionHash` (those are for paid skills only).
   - Ownership-only skills (`get-domain-info`, `list-dns-records`,
     `get-mailbox-info`, ...) execute right here — skip to step 6.
   - Capability-gated skills (`set-dns-record`, `delete-dns-record`,
     `transfer-domain-out`, `change-password`, `delete-mailbox`) do NOT
     execute yet: the call returns `state: "input-required"` with a
     `capability_challenge` artifact (the per-action EIP-712 typed-data)
     plus `nextEnvelopeAuthChallenge` — a pre-minted FRESH envelope for
     the execute call. Envelopes are single-use: reusing the step-3
     `messageId` is rejected as `ENVELOPE_REPLAY`.
5. **(Capability-gated only)** Sign BOTH typed-datas — the capability
   challenge and `nextEnvelopeAuthChallenge.eip712TypedData` — then call
   `daski_submit_task` once more with
   `capability: { signature, authorization }`, `envelopeAuth` from the
   fresh challenge, its `messageId`, the same `serviceArgs`/`paymentId`,
   and the `contextId` returned in step 4.
6. Poll `daski_get_task_status` (or pass `stream: true`) until completion.

Open free skills (`check-availability`, `get-pricing`) skip the
handshake entirely: call `daski_submit_task` directly with
`paymentId: "0"` and no envelopeAuth. The plan returned by `daski_buy_service`
will reflect this.

## Errors you'll see

- `missing_fields` — `daski_buy_service` validation failed against the
  skill's `requiredFields`. Prompt the user for each listed field, then
  retry.
- `ambiguous_provider` — multiple providers offer the skillId. Pick one
  from the returned list and re-call with explicit `providerTokenId`.
- `skill_not_found` — no whitelisted provider offers this skill. Call
  `daski_search_services` (with or without an `intent` query) to see
  what's available; the user may have asked for something the
  marketplace doesn't carry yet. For full provider details, read the
  `daski://provider/{tokenId}` MCP resource.
- `payment_id_required` — you tried a free ownership-gated skill without
  a `paymentId`. Ask the user which prior purchase this operates on.
- `MESSAGE_ID_REQUIRED` / `MESSAGE_ID_MISMATCH` from `daski_submit_task`
  — you passed `envelopeAuth` but no matching `messageId`, or the two
  diverged. Use the `messageId` returned by the first (no-envelopeAuth)
  `daski_submit_task` call verbatim.
- `envelope auth rejected (ENVELOPE_*)` from the provider — the signed
  envelope failed verification. Common causes: stale `issuedAt` (build
  a fresh one and re-sign), `serviceArgs` mutated between sign and
  submit (rebuild + re-sign), or the wallet signing is not the agent
  wallet on file for the buyerTokenId.
- rpcCode `-32110`, "The signed request does not match this request" — the
  submitted `serviceArgs` differ from the body bound into the envelope
  signature. Submit EXACTLY the args you signed. A common trap is adding an
  optional field after signing (for example `ttl`) even though the provider
  would have applied its own default. Either resend the exact signed args, or
  build and sign a fresh envelope over the changed body.
- `invalid_exact_evm_payload_signature` from `daski_settle_payment` —
  the wallet signed against a different `from` address than the one
  baked into the typed-data. Check that the wallet you're using for
  signing matches the `walletAddress` you passed to `daski_purchase`.
- `authorization_expired` — the challenge's TTL elapsed before settle.
  Open a fresh `daski_purchase` and retry.
- `EIP-3009 nonce already consumed` — replay attempt. Open a fresh
  challenge and retry with the new typed-data.
- `PROVIDER_TIMEOUT` / provider unreachable after you submitted a signed
  envelope — the request MAY have been processed and the envelope is
  consumed either way. Never re-send the same envelope/messageId
  (`ENVELOPE_REPLAY`); verify actual state with a read-only skill
  (`get-domain-info`, `list-dns-records`, `get-mailbox-info`, …) and only
  rebuild + re-sign a FRESH envelope if the action didn't take effect.
- Repeated `PROVIDER_ERROR` with `rpcCode: -32603` ("Internal error
  (ref …)") on the same skill+args, while other skills on the same
  provider succeed — that's a provider-side bug, not your input. Stop
  after two identical failures with different refs: verify no partial
  effect with a read-only skill, then report the failing skill, the
  asset, and all `ref` ids to your principal as a ready-to-forward
  escalation summary. There is no in-band support-ticket tool — do not
  keep spending signatures on blind retries.

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
2. daski_search_services({ intent: "register a .xyz domain" })
   → { providers: [{ tokenId: "1", ... }] }
3. daski_buy_service({
     skillId: "register-domain",
     providerTokenId: "1",
     walletAddress: "0xabc...",
     serviceArgs: { domain: "example.xyz" }
   })
   → { kind: "paid", paymentRequirements, plan: [...] }
4. wallet.signTypedData(paymentRequirements.extra.daski.eip712TypedData)
   → "0x123...signature"
5. daski_buy_service({ ...same args, paymentPayload, paymentRequirements })
   → { paymentId: "42", transactionHash: "0x...", serviceRef: "0x...",
       providerA2AUrl: "https://...", buyerTokenId: "5" }
6. daski_submit_task({                  // first call — no envelopeAuth
     providerA2AUrl, skillId: "register-domain",
     paymentId: "42", chainId: 84532, buyerTokenId: "5",
     serviceRef, transactionHash,
     serviceArgs: { domain: "example.xyz" }
   })
   → { messageId, eip712TypedData, authorization, hint }
7. wallet.signTypedData(eip712TypedData) → envelope signature
8. daski_submit_task({                  // second call — signed retry
     ...same args, messageId,
     envelopeAuth: { signature: <step 7>, authorization: <step 6> }
   })
   → { taskId: "task-7", state: "submitted" }
9. Loop: daski_get_task_status({ providerA2AUrl, taskId })
   until state == "completed" (or pass stream:true for SSE)
10. Surface artifacts. Then two-call daski_confirm_delivery:
    a. daski_confirm_delivery({ paymentId, attester, confirmation: "Confirmed" })
       → { eip712TypedData, deadline }
    b. wallet.signTypedData(eip712TypedData) → { v, r, s }
    c. daski_confirm_delivery({ ...same args, deadline, signature: { v, r, s } })
       → { attestationUid, transactionHash, success: true }
```
