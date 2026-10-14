# Provider wire fixtures

The canonical, synthetic contract between the Daski gateway and a provider
built from `daski-io/provider` or `daski-io/provider-full`. Every request in
this directory is what the gateway's own builders and signers send, driven with
the fixed test-only keys in `keys.json`, a fixed clock and planned nonces.
Every answer is built by the reference provider in the gateway's
`test/helpers/providerWire.ts`, and `test/providerWireConsumer.test.ts` runs it
through the gateway's actual validation and holds it to its stated verdict.
Nothing here is private, live or production-derived: no key signs anything
real, and every URL, identifier, amount and chain position is invented.

The files are generated. Do not edit them by hand.

## Files

| File | Contents | Starter handler |
| --- | --- | --- |
| `manifest.json` | Schema version, consumers and the sha256 of every other file. | none |
| `keys.json` | Synthetic keys: gateway dispatch, quote and lifecycle signers, provider authority and terminal attestation keys, a payer EOA and an unrecognized key, each derived from its label. | configuration |
| `context.json` | Rail, provider, listing, order, payment, result and support facts every vector is bound to. | configuration |
| `quote.json` | `ProviderQuoteRequestV1` (fixed with null and lowercase payer, dynamic) and quote answers at receipt-time edges. | quote |
| `intake.json` | `ProviderIntakeRequestV1` at the quote URL and intake answers. | intake |
| `dispatch.json` | Dispatch POSTs (initial, fresh envelope after a refusal, first dispatch 26 hours after the quote) and answers: admitted states, definite refusals, ambiguity, rejected answers. | dispatch |
| `dispatch-status.json` | `DispatchStatusQueryV1` polls for the original dispatch hash, admitted answers, the no-claim 404 and answers that never prove absence. | dispatch status |
| `lifecycle.json` | Lifecycle POSTs under a grant-attested read capability or a payer-signed authorization, their headers, answers and the named refusals. | lifecycle |
| `terminal-evidence.json` | Reads of a completed order whose terminal identity must equal the first attestation forever. | lifecycle, terminal freezing |
| `operations.json` | Observation sequences and the gateway's freshness and revision verdicts. | every signed answer |
| `deadlines.json` | Gateway fulfillment deadlines and the initial dispatch horizon. | none (gateway clocks) |
| `envelope-negatives.json` | Requests every handler must refuse. | every handler |

## Conventions

- Times are unix seconds. A request names the gateway clock it was sent at
  (`gateway.now`). An answer names the provider clock it was built at
  (`provider.now`, the `observedAt` or `issuedAt` it stamps) and the gateway
  clock it is checked at (`gateway.receivedAt`). `gateway.orderState` and
  `gateway.orderStateAfter` are the gateway's order state before and after the
  answer, and each file's `verdicts` names what its verdicts mean.
- `canonicalJson` sorts object keys by UTF-16 code unit, writes no whitespace
  and writes strings and numbers as `JSON.stringify` does; `canonicalHash` is
  keccak256 of its UTF-8 bytes.
- A gateway envelope is `{artifactType, schemaVersion, environment, chainId,
  audience, signerKeyId, issuedAt, validBefore, payload, signature}`. Its
  signature is EIP-191 `personal_sign` over the raw 32-byte `canonicalHash` of
  the envelope without `signature`, by the key `signerKeyId` names. One gateway
  key signs several envelope types: check `artifactType` and `schemaVersion`
  before trusting any signature.
- Provider signatures are EIP-191 `personal_sign` over the raw 32-byte
  `canonicalHash` of the signed object, as each file's `signature` note states.
  The payer authorization is EIP-712 `OrderActionAuthorizationV1` in the domain
  `{name: "DaskiStandardOrder", version: "1", chainId}`.
- ECDSA here is deterministic (RFC 6979, low s, v of 27 or 28), so a correct
  provider reproduces every signature exactly.
- `appliesTo` names the starters a vector concerns; lite answers support, input
  and cancel with the `unsupported_action` refusal, and only full prices
  dynamically or keeps support state.

## Matching an answer exactly

Configure the provider from `keys.json` and `context.json`, freeze its clock at
`provider.now`, give the order the vector's task state (`taskId`, `state`, the
frozen result whose `canonicalHash` is `resultHash`, `completedAt`, operations
revision and content), and send the request's exact `http.bodyText` with
`http.headers` to the handler. The answer matches when its status equals
`response.status`, it is `application/json` without `content-encoding`, and
`canonicalJson` of the parsed body equals `canonicalJson(response.body)`. Key
order and whitespace are free; every value, every signature included, is not.
A lite artifact is its frozen result, so its hash equals the attested
`resultHash`; a full artifact may reveal protected fields while every
attestation keeps the frozen unrevealed projection's hash.

Each vector states the gateway's verdict. `accepted`, `refused` and `noClaim`
answers are the ones a correct provider gives for those inputs. `ambiguous`,
`unknown` and `rejected` vectors show what the gateway does with anything else:
it polls status for the original dispatch hash, keeps the claim, or refuses the
answer. The empty 503 is the deliberate ambiguous answer for a dispatch whose
admission is uncertain; the no-claim 404 is reserved for an authoritative
lookup that finds no claim for the order.

## Requests a provider must refuse

`envelope-negatives.json` holds requests built from the real ones with one
defect each, every other signature valid. Send `JSON.stringify(http.body)` with
`http.headers`; each must be refused before any lookup, admission or mutation,
and a status handler must never answer one with the no-claim 404. `check`
states the defect in a form a test can verify.

## Vendoring and verifying

A starter vendors this directory verbatim at `test/fixtures/provider-wire/`
and records its source beside it, outside the directory, in
`test/fixtures/provider-wire.source.json`:

```json
{
  "repository": "daski-io/gateway",
  "commit": "<40-hex gateway commit>",
  "path": "test/fixtures/provider-wire",
  "manifestSha256": "<sha256 of manifest.json>"
}
```

Its tests read only the vendored files and never download anything. Its CI
checks, offline, that every file `manifest.json` lists exists with that
sha256, that the directory holds exactly `manifest.json` and those files, that
`manifest.json` hashes to `manifestSha256`, and that `manifest.schemaVersion`
is one its tests support. Mark the directory `-text` in `.gitattributes` so no
checkout rewrites line endings.

To re-vendor from a gateway checkout at the recorded commit:

```sh
git -C ../gateway archive <commit> test/fixtures/provider-wire | tar -x
git -C ../gateway show <commit>:test/fixtures/provider-wire/manifest.json | sha256sum
```

## Regenerating

Gateway maintainers own changes to this contract; both starter maintainers
review them. After an intentional change:

```sh
UPDATE_PROVIDER_WIRE_FIXTURES=1 npx vitest run test/providerWireFixtures.test.ts
npx vitest run test/providerWireConsumer.test.ts
```

CI regenerates the directory and fails on any byte difference or untracked
file, then re-vendor it into both starters with the new commit.
