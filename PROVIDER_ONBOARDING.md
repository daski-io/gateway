# Daski provider onboarding contract

What a service provider needs to ship to be reachable from the Daski
gateway. The reference implementation is a domain-management service
that lives at `daski-provider`; this doc captures the wire contract so
new providers can be implemented without reading the reference code
line-by-line.

This is a normative spec for the gateway↔provider boundary. Anything
the gateway depends on is here; anything that's an implementation detail
of the reference provider is not.

---

## 1. ERC-8004 identity

Every provider is an ERC-8004 agent. Mint your `agentId` via the
**canonical** per-chain ERC-8004 `IdentityRegistry` — Daski no longer
deploys an identity registry of its own:

- Base mainnet: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Base Sepolia (sandbox): `0x8004A818BFB912233c491871b3d84c89A494BD9e`

The agent's `agentURI` MUST resolve to a publicly-reachable Agent Card.

**Payee wallet is mandatory.** After minting you MUST call
`setAgentWallet` on the canonical registry (or set a per-service
`serviceWallet` in the Daski `ServiceRegistry`) before any payment can
settle. The canonical registry never auto-sets `agentWallet` — it is
zero at registration and cleared on every NFT transfer — and
`PaymentRouter` rejects settles when it cannot resolve a payee.

Optional: the Daski `AgentIndex` contract keeps a verified
wallet → agentId reverse index. Calling `claim(agentId)` on it is
OPTIONAL for providers — only buyers need a binding there (it is how
payments are attributed to the paying wallet).

The gateway treats the on-chain whitelist as the source of truth — your
`agentId` must be in `WHITELISTED_AGENT_IDS` on the gateway's config (or
admitted via the gateway's admin route) before discovery picks you up.

> Note: the buyer-side flow is different. Buyers pass an optional `name`
> to `daski_buy_service` (which auto-registers on first purchase) or to
> `daski_register_agent` (or `agentURI` to the latter, for the rare case
> of a self-hosted card); the gateway builds the agentURI for them and
> caches the display name. Providers always need a real hosted Agent
> Card because they expose A2A endpoints — the buyer flow's `data:` URI
> shortcut is not appropriate for the seller side.

---

## 2. Agent Card

Serve a JSON document at a stable, public URL (the `agentURI` you
register on chain). Convention is `/.well-known/agent-card.json` per
A2A spec §4.4. The card MUST declare:

- `name` — human-readable provider name. Surfaced on the marketplace UI
  and the agent's tool descriptions.
- `url` — your A2A JSON-RPC endpoint (e.g. `https://example.com/a2a`).
- `skills[]` — every skill you advertise, each with at minimum
  `{ id, name, description }`.
- `extensions["https://daski.xyz/a2a/v1"]` — the Daski marketplace
  extension envelope. Required fields:
  - `category` — one of the gateway's known categories (current set:
    `infrastructure`, `hosting`, `compute`, `legal`, `email`).
  - `serviceDescription` — one paragraph of plain prose; the website
    renders this verbatim.
  - `serviceLifecycle` — `"asset-lifecycle"` (you produce a durable
    asset like a domain), `"one-shot"` (no follow-up after delivery),
    or `"long-running"` (multi-step task).
  - `turnaroundEstimate` — human string, e.g. `"5-10 minutes"`.
  - `pricing` — `{ currency, baseAmount?, model?, variable?,
    billingModel? }`. For live-priced skills omit `baseAmount` and set
    `model: { kind: "live", source: "registrar", hint: "..." }`.
  - `skills[<skillId>]` — per-skill metadata, keyed by skill id (NOT a
    nested array). Required keys:
    - `paymentRequired` (default `true`)
    - `variablePricing` (default `false`)
    - `requiredFields[]` — the structured fields the agent must pass
      under `serviceArgs`. The gateway validates these before opening
      a payment challenge.
    - `requiresAssetOwnership` (default `false`) — the gateway will
      pass `paymentId` of the asset purchase if true.
    - `requiresCapability` (default `false`) — set to `true` for skills
      that need an EIP-712 signed authorization (see §5).
    - `assetType` — string identifier for the asset class
      (e.g. `"domain"`); the gateway uses this to find the buyer's
      prior purchase.
    - For variable-priced skills: `pricingModel: { kind, source, hint }`.

Sanitization: the gateway strips control characters and BIDI overrides
from any free-text field before reflecting it to LLM clients. Don't
rely on injecting markdown / control chars to influence agent behavior;
those bytes will not survive.

---

## 3. A2A endpoint

Serve JSON-RPC at the URL declared in the Agent Card's `url` field.
The gateway speaks A2A v1.0 (PascalCase methods like `SendMessage`,
`GetTask`, `SubscribeToTask`). Pre-1.0 method names are accepted in
parallel by the reference provider; new providers SHOULD ship 1.0 from
day one.

### 3.1 SendMessage (paid skills)

For payment-required skills, the gateway forwards a `SendMessage`
envelope after settlement. Every paid request includes the daski
extension metadata at `params.message.metadata[<extensionUri>]`:

```jsonc
{
  "skillId": "register-domain",
  "paymentId": "42",
  "chainId": 84532,
  "serviceRef": "0x…32bytes",
  "transactionHash": "0x…32bytes"
}
```

The provider MUST verify on-chain that `transactionHash` actually
settled the indicated `paymentId` for `serviceRef` against a
`buyerTokenId` and `providerTokenId` matching this provider, before
doing any work. Failure to verify is a payment-fraud surface — the
gateway's metadata is a hint, not an authority.

### 3.2 SendMessage (free open skills, e.g. `check-availability`)

For open free skills, the gateway forwards `SendMessage` with NO
`paymentId` / `serviceRef` / `transactionHash`. The provider executes
synchronously and returns the result inline in `result.artifacts[]`
plus an optional `result.status.message` (final-state envelope, no
persistent task row). The gateway's `daski_submit_task` flattens these
to the agent in one round trip — agents should not poll for free open
skills.

### 3.3 SendMessage (free ownership-gated skills, e.g. `set-dns-record`)

The metadata includes a `paymentId` (the asset's original purchase) and
a `capability` block (signed EIP-712 typed-data; see §5). The provider
verifies the capability against the on-chain agent wallet and the
asset's recorded ownership before executing. Tasks ARE persisted (the
agent gets a real `taskId` and polls).

### 3.4 GetTask / SubscribeToTask

Standard A2A. The gateway exposes both via the merged
`daski_get_task_status` tool. Long-running paid skills SHOULD support
SSE so the gateway can forward provider events as MCP progress
notifications.

---

## 4. Sibling endpoints (optional)

Two sibling endpoints earn their slot when wrapping the work in the
A2A task lifecycle is overkill:

- `POST /availability/<serviceSlug>` — synchronous lookup mirror of the
  `check-availability` skill. Same shape as the A2A path, no JSON-RPC
  envelope. The gateway's legacy `/availability` proxy targets this.
  Optional; if you don't ship it, agents reach `check-availability`
  through `daski_submit_task`.
- `POST /quote/<serviceSlug>` — live-pricing quote endpoint. Required
  for any skill that advertises `pricingModel.kind: "live"`. The
  gateway's `daski_buy_service` calls this before opening a payment
  challenge so the buyer sees a real number.

---

## 5. Capability prep (free A2A skill)

If your service has any skill with `requiresCapability: true`, you MUST
also expose a `prepare-*-capability` free A2A skill that returns the
EIP-712 typed-data for that capability. The reference provider's
`prepare-dns-capability` skill is the template:

- Takes the same fields the capability-gated skill takes.
- Returns `eip712TypedData` (full struct) + a `capabilityTemplate`
  (pre-filled `authorization`) in artifacts.
- Stores no state; the buyer's wallet signs it; the signed pair flows
  back through the capability-gated skill where you verify it.

The gateway used to host the typed-data builder (legacy
`/capability-prep/dns` route, removed 2026-05). New providers should
NOT expect a centralized prep endpoint — the schema lives with the
skill it authorizes.

---

## 6. Reputation

After every delivery, the buyer signs an EAS attestation
(`Confirmed`/`NotConfirmed`) which the gateway facilitator submits on
chain against the `EAS_CONFIRMATION_SCHEMA_UID`. Providers SHOULD treat
on-chain reputation as ground truth; the marketplace UI ranks providers
by these counters and providers should expect this to feed into
discovery sort order over time.

---

## 7. Embedding quality (search ranking)

The gateway embeds each skill on cache refresh (Xenova
`all-MiniLM-L6-v2`, 384-dim, pgvector). The text it embeds includes
your `name`, `serviceDescription`, `category`, plus per-skill `id`,
`name`, and `description`. To rank well on intent queries:

- Don't dump SEO keyword soup — the embedder rewards semantic match
  over keyword density.
- Skill descriptions should describe what the agent gets, not how you
  built it. "Register a new .com domain with automated DNS" beats
  "Synchronous registrar API wrapper".
- Keep `serviceDescription` to one paragraph. Longer text dilutes the
  embedding.

---

## 8. Discovery refresh

The gateway re-fetches Agent Cards on a `CACHE_REFRESH_INTERVAL`
schedule (default 60s in dev, longer in prod). Embedding sync runs
lazily on the first `daski_search_services` call after a cache change.
Practical impact: a skill update lands in the catalog within one
refresh cycle, and in search results on the next intent query.

If you change a skill's id you'll temporarily have two embeddings
(old and new); the old one expires when the next refresh sees it gone.
Don't churn skill ids unnecessarily.

---

## 9. Reference implementation

`daski-provider` (the domain-management reference implementation) is
the canonical example. Read order if you're building a new provider:

1. `src/agentCards/generator.ts` — Agent Card shape with the daski
   extension envelope.
2. `src/a2a/handlers/paidSkill.ts` and `freeSkill.ts` — request
   routing, on-chain payment/asset verification, capability checks.
3. `src/adapters/domainManagement/index.ts` — adapter interface
   (`execute`, `quote`, `handleInput`, `cancel`). New service types
   implement this.
4. `src/db/migrations/` — schema for services, skills, tasks, assets,
   capability nonces.

A future "provider scaffolder" CLI would generate (1) and (4)
automatically; for now it's a copy-paste-and-rename.
