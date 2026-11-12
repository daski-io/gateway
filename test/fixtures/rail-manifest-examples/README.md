# Rail manifest examples

Complete, synthetic standard-rail manifests, each with the verdict the gateway
gives it when it starts. The gateway reads its manifest once, at start, and
refuses to start on one it cannot verify. Anything that edits a manifest before
a gateway reads it can replay the same rules first; these examples keep such a
replay equal to the gateway's own check.

Nothing here is private, live or production-derived: every key derives from a
public label and signs nothing real, and every host, identifier, hash and time
is invented.

The files are generated. Do not edit them by hand.

## Files

| File | Contents |
| --- | --- |
| `manifest.json` | Schema version, consumers and the sha256 of every other file. It is the checksum list, not a rail manifest. |
| `examples.json` | The trust inputs, the clock, the synthetic keys and the example rail manifests. |

## Reading `examples.json`

- `trust` is what the gateway is configured with: its environment, chain id and
  audience, and the signer addresses it trusts per key ID.
- `clock.now` is the instant, in unix seconds, at which every verdict holds. An
  envelope is valid while `issuedAt <= now < validBefore`.
- `keys` holds the synthetic keys with their labels. A signature is EIP-191
  `personal_sign` over the raw 32-byte keccak256 of the canonical JSON of the
  envelope without its `signature`. Canonical JSON sorts object keys by UTF-16
  code unit and writes no whitespace. ECDSA here is deterministic (RFC 6979),
  so the set regenerates byte for byte.
- `sharedOrigin` states the exact texts the shared-origin profiles use: the
  origin without a trailing slash, the audience with one, and each provider's
  URLs under `/p/<providerAgentId>/`. They are the texts the gateway stores
  from a provider card that names the same origin and audience, so a profile
  and a stored card compare as equal strings.
- Each entry of `examples` is one complete manifest:
  - `verdict: "accepted"`: the check resolves, and `gatewayError` is null.
  - `verdict: "refused"`: the check rejects with exactly `gatewayError`. Every
    refused example is `accepted.shared-origin` with the one defect its
    `purpose` names. Every envelope the defect does not concern keeps a valid
    signature.

The check is `verifyStandardRailManifest` in `src/standardRail/artifacts.ts`:
every envelope's type, domain, validity window and signer, the control profile
rules, and the bindings between servicing admissions, action catalogs and
control profiles. Decoding a manifest from its transport encoding and the size
limit on it are outside this set.

## What the accepted examples establish

- Two providers may share one origin, one provider wallet and one audience.
  They are told apart by agent id and by path.
- A control profile needs no servicing admission and no action catalog. An
  admission needs a carried profile and catalog of its own agent.
- An origin verifies with or without a trailing slash.

`test/sharedOriginProviders.test.ts` sells through `accepted.shared-origin`:
both providers' listings assemble, each provider's calls go to its own path,
and the provider without an admission is sold while its assets answer
`not-admitted`.

## Vendoring and verifying

A repository that replays these rules vendors this directory verbatim and
records its source beside it, outside the directory:

```json
{
  "repository": "daski-io/gateway",
  "commit": "<40-hex gateway commit>",
  "path": "test/fixtures/rail-manifest-examples",
  "manifestSha256": "<sha256 of manifest.json>"
}
```

Its tests read only the vendored files and never download anything. They
check that every file `manifest.json` lists exists with that sha256, that the
directory holds exactly `manifest.json` and those files, and that
`manifest.schemaVersion` is one they support. Then they set the clock to
`clock.now`, run each example through their own copy of the rules and require
the same verdict. Mark the directory `-text` in `.gitattributes` so no checkout
rewrites line endings.

## Regenerating

After an intentional change to the manifest rules or to the set:

```sh
UPDATE_RAIL_MANIFEST_EXAMPLES=1 npx vitest run test/railManifestExamples.test.ts
npx vitest run test/railManifestExamples.test.ts test/sharedOriginProviders.test.ts
```

The test compares the committed bytes with what the builders in
`test/helpers/railManifestExamples.ts` sign and fails on any difference or
unlisted file. A changed set names the new gateway commit for its consumers to
re-vendor.
