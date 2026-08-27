# Provider service registration v1

This document defines the public, gateway-optional enrollment path implemented
by Daski Gateway. It does not change whether a provider or service is valid on
chain. Canonical provider identity and service state remain in ERC-8004,
ProviderRegistry, and ServiceRegistry.

The implementation is dark by default. Setting
`DYNAMIC_SERVICE_REGISTRATION_ENABLED=true` exposes the registration and
service-first catalog resources. Activating those resources does not switch the
historical purchase path; that requires a separately reviewed R3 release.

## Provider workflow

A provider:

1. registers its ERC-8004 identity and Daski provider row;
2. registers the service through ServiceRegistry with its own wallet;
3. publishes a Daski v2 Agent Card at the finalized on-chain `serviceURI`;
4. reads `GET /public/v3/registration-policy`;
5. signs and posts one complete registration intent;
6. verifies and durably stores the returned preparation;
7. broadcasts any returned deterministic splitter deployments with its wallet;
8. signs and submits the finalized transaction hashes.

The gateway never accepts a caller-selected card URL and never receives the
provider private key. Direct registration on chain remains interoperable but is
not crawled or automatically shown by this gateway.

## Resources

- `GET /public/v3/registration-policy`
- `POST /v1/service-registrations`
- `GET /v1/service-registrations/{registrationId}`
- `POST /v1/service-registrations/{registrationId}/evidence`
- `GET /public/v3/services`
- `GET /public/v3/services/{serviceId}`
- `PUT /operator/v1/services/{registrationId}/visibility`

The initial POST requires an `Idempotency-Key` of 8–128 URL-safe characters.
The same provider/key/body returns the persisted resource; using the same key
for another body is a conflict. One service may have only one pending revision.

## Signed envelope

Both provider messages use the closed JSON envelope below. Signatures are
secp256k1 personal signatures over the gateway canonical artifact-payload hash.

```json
{
  "artifactType": "ProviderServiceRegistrationIntentV1",
  "schemaVersion": 1,
  "environment": "testnet",
  "chainId": 84532,
  "audience": "https://gateway.example",
  "signerKeyId": "provider-authority",
  "issuedAt": 0,
  "validBefore": 0,
  "payload": {},
  "signature": "0x…65-bytes"
}
```

The domain must match the gateway policy. The validity window is at most ten
minutes, and the recovered signer must be the current finalized ERC-8004 owner
or agent wallet for the provider. Exact persisted retries remain recoverable
after the initial validity window; new or altered messages do not.

### `ProviderServiceRegistrationIntentV1`

The payload is closed and contains:

- `providerAgentId`, `serviceId`, `serviceSlug`, and `serviceVersion`;
- `providerPayee`;
- `serviceContractHash`;
- `skillContractSetHash`;
- sorted unique `skills[]` entries containing `skillId` and
  `skillContractHash` for every paid or free skill;
- `railPolicyHash`;
- a unique 32-byte `registrationNonce`.

The service contract hash binds the on-chain service identity, open taxonomy,
jurisdictions, lifecycle and order-acceptance state, every same-origin
standard-rail endpoint, provider/marketplace legal metadata, and the complete
skill-contract set hash. Presentation-only name, description, turnaround, and
skill presentation changes are deliberately outside it. The gateway compares
the service hash, every skill entry, and the complete skill set hash with the
card read from the finalized chain URI. This makes endpoint/legal drift and
free mutation/destructive actions part of provider consent as well as paid
skills.

### `ProviderServiceRegistrationEvidenceV1`

The payload contains `registrationId`, the canonical
`preparedRegistrationHash`, `expectedState`, unique
`splitterTransactionHashes[]`, and a unique 32-byte `evidenceNonce`.
Evidence is rechecked against finalized canonical receipts, factory bytecode,
CREATE2 address derivation, emitted deployment data, and live splitter
immutables before activation.

## Card contract

The Daski extension key is `https://daski.xyz/a2a/v2`. It is a closed,
versioned object. Unknown extension fields fail closed. Category and service
type are bounded open identifiers; they are not admission allowlists.

Each skill publishes presentation plus a contract containing closed
input/result schemas, USDC pricing, capacity/deadline bounds,
`acceptingNewOrders`, and optional asset-action metadata. Payment status is
derived from canonical pricing and must agree with the duplicated boolean.
An action is exposed only when it has an admitted, gateway-signed control
profile. Unknown action fields/effects fail closed, and destructive actions
require delayed confirmation metadata that binds at least one request field.

Normal card revisions retain the on-chain service version and `serviceId`.
A deliberate ServiceRegistry version change creates a distinct service
identity, listing keys, and splitters.

## Visibility and refresh

A successfully activated Base Sepolia registration defaults visible. A Base
Mainnet registration defaults hidden. This is a gateway database decision only.

The gateway refreshes the finalized service/provider authority and card.
Presentation may use a last-known-good card for up to 24 hours. New commerce
will require a card validated within five minutes when the dynamic catalog is
cut over to purchases. Contract, authority, payee, URI, or rail-policy drift
fails closed and requires a new signed revision. Existing orders remain bound
to their immutable historical listing snapshots.

Operator visibility changes are authenticated and audited. Visibility affects
discovery and future commerce only; it does not invalidate chain state or
interrupt already admitted order recovery.
