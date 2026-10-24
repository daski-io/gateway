import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash } from "../../src/standardRail/canonical.js";
import {
  orderActionSignRequest,
  type OrderAction,
  type OrderActionChallenge,
} from "../../src/standardRail/orderAuthorization.js";
import { signEnvelope } from "../../src/standardRail/signing.js";
import type {
  QuoteV1,
  SignedEnvelope,
  StandardOrderRecord,
  StandardRailDispatchV2,
} from "../../src/standardRail/types.js";
import {
  ADDRESSES, AT, BUYER_REQUESTS, CHAIN_ID, COMMISSION_BPS, COMMISSION_RECEIVER, CONTROL_PROFILE, CONTROL_PROFILE_HASH,
  DEADLINE_POLICY, ENVIRONMENT, FACILITATOR_CONFIRMATION_HASH, FIXTURE_SCHEMA_VERSION, FULL, GATEWAY_URL, KEY_ROLES,
  LISTINGS, LITE, NONCES, ORDER_HANDLE, ORDER_ID, ORDER_KEY, OUTCOME_SCHEMA_UID, PAYMENT, PRIVATE_KEYS, PROVIDER_AGENT_ID,
  PROVIDER_ORIGIN, PROVIDER_PAYEE, RAIL_PROFILE_HASH, REPUTATION_CONTRACT, REQUEST_SCHEMA, RESULTS, SERVICE_ID,
  SERVICE_RESULT_SCHEMA, STARTERS, SUPPORT, TASK_ID, TASK_PROJECTION_SCHEMA, TOKEN,
  at, dispatchBody, driveChallenge, driveDispatch, driveIntake, driveLifecycle, fixtureListing, fixtureOrder,
  httpResponse, json, keyLabel, lifecycleBody, operationsView, payerAuthorization, plan, providerSign, quoteBody, raw,
  type Entropy, type KeyName, type ListingKind, type WireRequest, type WireResponse,
} from "./providerWire.js";

type Doc = Record<string, unknown>;
const OK = { "content-type": "application/json" };
const iso = (seconds: number) => new Date(seconds * 1_000).toISOString();

/** Purpose, consumers and starter handler of every file in the set; manifest.json is built from it. */
export const FIXTURE_FILES: Record<string, { purpose: string; exercises: string }> = {
  "README.md": {
    purpose: "How the set is generated, compared, vendored and verified.",
    exercises: "documentation",
  },
  "keys.json": {
    purpose: "Synthetic test-only signing keys of the gateway, provider and payer, with their derivation.",
    exercises: "provider configuration for every handler below",
  },
  "context.json": {
    purpose: "Synthetic rail, provider, listing, order and payment facts every vector is bound to.",
    exercises: "provider configuration for every handler below",
  },
  "quote.json": {
    purpose: "ProviderQuoteRequestV1 the gateway sends (fixed with null and lowercase payer, dynamic) and " +
      "quote answers with the gateway's verdict at receipt.",
    exercises: "quote handler: POST quoteUrl with a ProviderQuoteRequestV1",
  },
  "intake.json": {
    purpose: "ProviderIntakeRequestV1 the gateway sends to the quote URL and intake answers with the gateway's verdict.",
    exercises: "intake handler: POST quoteUrl with a ProviderIntakeRequestV1",
  },
  "dispatch.json": {
    purpose: "Dispatch POSTs (initial, fresh envelope after a refusal, first dispatch 26 hours after the " +
      "quote) and dispatch answers: accepted states, definite refusals, ambiguity and rejected answers.",
    exercises: "dispatch handler: POST dispatchUrl",
  },
  "dispatch-status.json": {
    purpose: "DispatchStatusQueryV1 polls for the original dispatch hash and answers: admitted states, the " +
      "no-claim 404 and answers that never prove absence.",
    exercises: "dispatch status handler: POST dispatchStatusUrl",
  },
  "lifecycle.json": {
    purpose: "Lifecycle POSTs with grant-attested read capabilities and payer-signed authorizations (status, " +
      "artifact, support, input, cancel), their headers, answers and the named refusals.",
    exercises: "lifecycle handler: POST lifecycleUrl",
  },
  "terminal-evidence.json": {
    purpose: "Lifecycle reads of a completed order whose terminal identity must never change after the dispatch attestation.",
    exercises: "lifecycle handler and terminal-result freezing",
  },
  "operations.json": {
    purpose: "Sequences of operations observations and the gateway's freshness and revision verdicts.",
    exercises: "operations projection, revision and observedAt stamping on every signed answer",
  },
  "deadlines.json": {
    purpose: "Gateway fulfillment deadlines (snapshot, recorded and current durations, paused sales, admitted " +
      "waits) and the initial dispatch horizon.",
    exercises: "none: the gateway clocks a declared fulfillment duration must cover",
  },
  "envelope-negatives.json": {
    purpose: "Requests a provider must refuse: cross-type envelopes, wrong audience, environment or chain, " +
      "stale or future envelopes, wrong signers, tampering and broken bindings.",
    exercises: "envelope verification in every handler",
  },
};

// ---------------------------------------------------------------------------
// The gateway's side: requests captured from the code that sends them.

interface QuoteRequestFixture { listing: ListingKind; now: number; http: WireRequest; providerQuote: Doc; quote: SignedEnvelope<QuoteV1> }
interface DispatchRequestFixture { now: number; http: WireRequest; dispatch: SignedEnvelope<StandardRailDispatchV2, 2>; dispatchHash: Hex }
interface LifecycleRequestFixture {
  action: OrderAction; access: "readCapability" | "payerSigned"; orderState: StandardOrderRecord["state"];
  now: number; http: WireRequest;
}
interface Story {
  quotes: Record<string, QuoteRequestFixture>;
  intake: { now: number; http: WireRequest };
  dispatches: Record<string, DispatchRequestFixture>;
  statuses: Record<string, { now: number; http: WireRequest }>;
  lifecycles: Record<string, LifecycleRequestFixture>;
}

function consumed(entropy: Entropy, step: string): void {
  if (entropy.queue.length !== 0) throw new Error(`${step} did not draw its planned entropy`);
}

async function challenge(entropy: Entropy, kind: ListingKind, payer: boolean, nonce: Hex, grossAmount: string,
  lifetime: number): Promise<QuoteRequestFixture> {
  plan(entropy, nonce);
  at(AT.quote);
  let providerQuote: Doc = {};
  const run = await driveChallenge({
    listing: fixtureListing(kind), body: BUYER_REQUESTS[kind], ...(payer ? { payerAddress: ADDRESSES.payer } : {}),
    respond: async (request) => {
      const envelope = request.body.request as { payload: { outcomeId: string; listingManifestHash: Hex; requestHash: Hex; payer: string | null } };
      providerQuote = await quoteBody({ ...envelope.payload, grossAmount, issuedAt: AT.quote, validBefore: AT.quote + lifetime });
      at(AT.quoteReceived);
      return httpResponse(json(200, providerQuote));
    },
  });
  consumed(entropy, `the ${kind} challenge`);
  if (!run.outcome.ok || !run.request || !run.draft) throw new Error(`The ${kind} challenge failed: ${String(run.outcome.ok || run.outcome.error)}`);
  return { listing: kind, now: AT.quote, http: run.request, providerQuote, quote: run.draft.quote };
}

async function dispatchRequest(entropy: Entropy, args: Parameters<typeof driveDispatch>[0], now: number, nonce: Hex) {
  plan(entropy, nonce);
  at(now);
  const run = await driveDispatch({ ...args, respond: () => httpResponse(raw(503, "")) });
  consumed(entropy, `the dispatch at ${now}`);
  if (!run.request || !run.claimed) throw new Error(`No dispatch was sent at ${now}: ${String(run.error)}`);
  return { now, http: run.request, dispatch: run.claimed, dispatchHash: canonicalHash(run.claimed) };
}

async function statusRequest(order: StandardOrderRecord, initial: DispatchRequestFixture, now: number) {
  at(now);
  const run = await driveDispatch({
    order: { ...order, state: "DISPATCH_AMBIGUOUS" },
    persisted: { dispatch: initial.dispatch, request: BUYER_REQUESTS.fixed },
    respond: () => httpResponse(raw(503, "")),
  });
  if (!run.request) throw new Error(`No status query was sent at ${now}: ${String(run.error)}`);
  return { now, http: run.request };
}

async function lifecycleRequest(entropy: Entropy, quote: SignedEnvelope<QuoteV1>, args: {
  action: OrderAction; access: "readCapability" | "payerSigned"; orderState: StandardOrderRecord["state"];
  now: number; request: Record<string, unknown>;
}): Promise<LifecycleRequestFixture> {
  const order = fixtureOrder(quote, { state: args.orderState, providerTaskId: TASK_ID });
  const access = args.access === "readCapability"
    ? { readCapability: true as const }
    : { authorization: await payerAuthorization({ order, action: args.action, request: args.request, issuedAt: args.now - 5, entropy }) };
  consumed(entropy, `the ${args.action} authorization`);
  at(args.now);
  const run = await driveLifecycle({
    order, action: args.action, request: args.request, access,
    respond: () => httpResponse(json(503, { error: "lifecycle_unavailable" })),
  });
  if (!run.request) throw new Error(`No ${args.action} call was sent: ${String(!run.outcome.ok && run.outcome.error)}`);
  return { action: args.action, access: args.access, orderState: args.orderState, now: args.now, http: run.request };
}

async function gatewayStory(entropy: Entropy): Promise<Story> {
  const quotes = {
    "fixed-payer-lowercase": await challenge(entropy, "fixed", true, NONCES.orderFixed, LISTINGS.fixed.fixedGrossAmount, 120),
    "fixed-payer-null": await challenge(entropy, "fixed", false, NONCES.orderFixedNoPayer, LISTINGS.fixed.fixedGrossAmount, 120),
    "dynamic-payer-lowercase": await challenge(entropy, "dynamic", true, NONCES.orderDynamic, "400000", 180),
  };
  at(AT.intake);
  const intakeRun = await driveIntake({ listing: fixtureListing("fixed"), request: { ...BUYER_REQUESTS.intake },
    respond: () => httpResponse(raw(503, "")) });
  if (!intakeRun.request) throw new Error("No intake request was sent");
  const quote = quotes["fixed-payer-lowercase"].quote;
  const order = fixtureOrder(quote);
  const initial = await dispatchRequest(entropy, { order, respond: () => httpResponse(raw(503, "")) }, AT.dispatch,
    NONCES.dispatchInitial);
  const dispatches = {
    initial,
    "retry-after-refusal": await dispatchRequest(entropy, {
      order: { ...order, state: "DISPATCH_STARTED" },
      persisted: { dispatch: initial.dispatch, request: BUYER_REQUESTS.fixed },
      recovery: { startedAt: AT.releaseObserved, retryPending: true, nextAttemptAt: AT.retry },
      respond: () => httpResponse(raw(503, "")),
    }, AT.retry, NONCES.dispatchRetry),
    "delayed-first-dispatch": await dispatchRequest(entropy, { order, respond: () => httpResponse(raw(503, "")) },
      AT.delayedDispatch, NONCES.dispatchDelayed),
  };
  const statuses = {
    working: await statusRequest(order, initial, AT.statusWorking),
    completed: await statusRequest(order, initial, AT.statusCompleted),
    "no-claim-within-grace": await statusRequest(order, initial, AT.noClaimWithinGrace),
    "no-claim-after-grace": await statusRequest(order, initial, AT.noClaimAfterGrace),
  };
  const lifecycle = (name: string, args: Parameters<typeof lifecycleRequest>[2]) =>
    lifecycleRequest(entropy, quote, args).then((value) => [name, value] as const);
  const lifecycles = Object.fromEntries([
    await lifecycle("status.read-capability.working", { action: "status", access: "readCapability",
      orderState: "DISPATCHED", now: AT.midway, request: {} }),
    await lifecycle("artifact.read-capability.working", { action: "artifact", access: "readCapability",
      orderState: "DISPATCHED", now: AT.midway, request: {} }),
    await lifecycle("input.payer-signed", { action: "input", access: "payerSigned", orderState: "INPUT_REQUIRED",
      now: AT.midway, request: { inputText: "Keep the title as written.", data: { title: BUYER_REQUESTS.fixed.title } } }),
    await lifecycle("cancel.payer-signed", { action: "cancel", access: "payerSigned", orderState: "DISPATCHED",
      now: AT.midway, request: {} }),
    await lifecycle("status.read-capability.completed", { action: "status", access: "readCapability",
      orderState: "FULFILLED", now: AT.lifecycleCompleted, request: {} }),
    await lifecycle("artifact.read-capability.completed", { action: "artifact", access: "readCapability",
      orderState: "FULFILLED", now: AT.lifecycleCompleted, request: {} }),
    await lifecycle("status.payer-signed.completed", { action: "status", access: "payerSigned",
      orderState: "FULFILLED", now: AT.lifecycleCompleted, request: {} }),
    await lifecycle("artifact.payer-signed.completed", { action: "artifact", access: "payerSigned",
      orderState: "FULFILLED", now: AT.lifecycleCompleted, request: {} }),
    await lifecycle("support.payer-signed", { action: "support", access: "payerSigned", orderState: "FULFILLED",
      now: AT.support, request: { requestId: SUPPORT.requestId, message: "Please confirm the note was saved." } }),
  ]);
  return { quotes, intake: { now: AT.intake, http: intakeRun.request }, dispatches, statuses, lifecycles };
}

// ---------------------------------------------------------------------------
// Static documents.

function keysDocument(): Doc {
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    testOnly: true,
    warning: "Synthetic keys derived from public labels. They sign nothing real, hold no funds and must never be configured for any network.",
    derivation: "privateKey = keccak256(utf8(label)); address = EIP-55 address of privateKey",
    keys: Object.fromEntries(Object.entries(KEY_ROLES).map(([name, role]) => [name, {
      label: keyLabel(name), ...(role.signerKeyId ? { signerKeyId: role.signerKeyId } : {}), role: role.role,
      privateKey: PRIVATE_KEYS[name as KeyName], address: ADDRESSES[name as KeyName],
    }])),
  };
}

function contextDocument(story: Story): Doc {
  const quote = story.quotes["fixed-payer-lowercase"];
  const listing = (kind: ListingKind) => {
    const facts = LISTINGS[kind];
    return {
      outcomeId: facts.outcomeId, skillId: facts.outcomeId, serviceId: SERVICE_ID,
      listingManifestHash: facts.listingManifestHash, providerOfferHash: facts.providerOfferHash,
      bindingProfile: "recipe-bound-v2", pricingMode: facts.pricingMode, fixedGrossAmount: facts.fixedGrossAmount,
      commissionBps: COMMISSION_BPS, token: TOKEN, splitter: facts.splitter, providerPayee: PROVIDER_PAYEE,
      daskiCommissionReceiver: COMMISSION_RECEIVER,
      absoluteResourceUri: `${GATEWAY_URL}/outcomes/${PROVIDER_AGENT_ID}/${facts.outcomeId}`,
      requestSchema: REQUEST_SCHEMA, responseSchema: SERVICE_RESULT_SCHEMA, deadlinePolicy: DEADLINE_POLICY,
      quotePolicy: facts.quotePolicy,
    };
  };
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    synthetic: "Every identifier, key, URL, amount and chain position here is invented for these fixtures; none exists on any network.",
    environment: ENVIRONMENT,
    chainId: CHAIN_ID,
    times: { ...AT },
    gateway: {
      publicUrl: GATEWAY_URL, audience: GATEWAY_URL,
      signers: { "gateway-dispatch": ADDRESSES.gatewayDispatch, "gateway-quote": ADDRESSES.gatewayQuote,
        "gateway-lifecycle": ADDRESSES.gatewayLifecycle },
      reputationContract: REPUTATION_CONTRACT, reputationOutcomeSchemaUid: OUTCOME_SCHEMA_UID,
      activeRailProfileHash: RAIL_PROFILE_HASH,
    },
    provider: {
      providerAgentId: PROVIDER_AGENT_ID, audience: PROVIDER_ORIGIN, controlProfile: CONTROL_PROFILE,
      controlProfileHash: CONTROL_PROFILE_HASH, authorityKey: ADDRESSES.providerAuthority,
      terminalAttestationKey: ADDRESSES.providerTerminalAttestation, payee: PROVIDER_PAYEE, controlledWallets: [],
    },
    listings: { fixed: listing("fixed"), dynamic: listing("dynamic") },
    order: {
      orderId: ORDER_ID, orderKey: ORDER_KEY, orderHandle: ORDER_HANDLE, providerTaskId: TASK_ID,
      payer: ADDRESSES.payer, quotePayer: ADDRESSES.payer.toLowerCase(), request: BUYER_REQUESTS.fixed,
      requestHash: canonicalHash(BUYER_REQUESTS.fixed), canonicalRequestHash: quote.quote.payload.canonicalRequestHash,
      providerQuoteHash: quote.quote.payload.providerQuoteHash, quoteHash: canonicalHash(quote.quote),
      orderNonce: quote.quote.payload.orderNonce, facilitatorConfirmationHash: FACILITATOR_CONFIRMATION_HASH,
      payment: PAYMENT,
    },
    results: {
      serviceResult: { schema: SERVICE_RESULT_SCHEMA, completed: RESULTS.serviceResult.completed,
        failed: RESULTS.serviceResult.failed },
      taskProjection: { schema: TASK_PROJECTION_SCHEMA, completed: RESULTS.taskProjection.completed,
        revealed: RESULTS.taskProjection.revealed, canceled: RESULTS.taskProjection.canceled },
    },
    support: { ...SUPPORT, acceptedAt: AT.support },
  };
}

// ---------------------------------------------------------------------------
// Quotes and intake.

async function quoteDocument(story: Story): Promise<Doc> {
  const fixed = story.quotes["fixed-payer-lowercase"];
  const payload = (request: QuoteRequestFixture) =>
    (request.http.body.request as { payload: { outcomeId: string; listingManifestHash: Hex; requestHash: Hex; payer: string | null } }).payload;
  const vectors: Doc[] = [];
  const add = async (id: string, request: string, purpose: string, provider: {
    grossAmount?: string; payer?: string | null; issuedAt?: number; validBefore?: number; signer?: KeyName;
    patch?: Doc; response?: (body: Doc) => WireResponse;
  }, gateway: Doc, appliesTo: readonly string[] = STARTERS) => {
    const source = story.quotes[request]!;
    const bound = payload(source);
    const fields = {
      outcomeId: bound.outcomeId, listingManifestHash: bound.listingManifestHash, requestHash: bound.requestHash,
      grossAmount: provider.grossAmount ?? LISTINGS[source.listing].fixedGrossAmount,
      payer: provider.payer === undefined ? bound.payer : provider.payer,
      issuedAt: provider.issuedAt ?? AT.quote, validBefore: provider.validBefore ?? AT.quote + 120,
      ...(provider.patch ?? {}),
    } as Parameters<typeof quoteBody>[0];
    const body = await quoteBody(fields, provider.signer);
    const { signature: _signature, ...signed } = body;
    const verdict = gateway.verdict === "accepted"
      ? { verdict: "accepted", grossAmount: fields.grossAmount, providerQuoteHash: canonicalHash(signed),
        issuedAt: fields.issuedAt, validBefore: fields.validBefore }
      : gateway;
    vectors.push({
      id, request, appliesTo, purpose,
      provider: { now: fields.issuedAt, signer: provider.signer ?? "providerAuthority", grossAmount: fields.grossAmount,
        payer: fields.payer, issuedAt: fields.issuedAt, validBefore: fields.validBefore, ...(provider.patch ? { bound: provider.patch } : {}) },
      response: provider.response ? provider.response(body) : json(200, body),
      gateway: { receivedAt: AT.quoteReceived, ...verdict },
    });
  };
  const unavailable = { verdict: "rejected", code: "PROVIDER_QUOTE_UNAVAILABLE" };
  await add("fixed.payer-lowercase.accepted", "fixed-payer-lowercase",
    "A 120-second fixed quote echoing the lowercase payer literally.", {}, { verdict: "accepted" });
  await add("fixed.payer-null.accepted", "fixed-payer-null", "A fixed quote for a request without a payer echoes null.",
    {}, { verdict: "accepted" });
  await add("fixed.payer-checksummed.rejected", "fixed-payer-lowercase",
    "The payer is compared literally: an EIP-55 echo of a lowercase payer is refused.", { payer: ADDRESSES.payer }, unavailable);
  await add("fixed.payer-dropped.rejected", "fixed-payer-lowercase", "A quote must bind the payer it was asked for.",
    { payer: null }, unavailable);
  await add("fixed.window-equals-minimum.rejected", "fixed-payer-lowercase",
    "At receipt the remaining window must exceed the 30-second payment window; exactly 30 is refused.",
    { validBefore: AT.quoteReceived + 30 }, unavailable);
  await add("fixed.window-one-past-minimum.accepted", "fixed-payer-lowercase",
    "31 seconds remaining at receipt is enough.", { validBefore: AT.quoteReceived + 31 }, { verdict: "accepted" });
  await add("fixed.lifetime-300.accepted", "fixed-payer-lowercase", "A fixed quote may last 300 seconds.",
    { validBefore: AT.quote + 300 }, { verdict: "accepted" });
  await add("fixed.lifetime-301.rejected", "fixed-payer-lowercase", "A fixed quote may not last 301 seconds.",
    { validBefore: AT.quote + 301 }, unavailable);
  await add("fixed.issued-30s-before-receipt.accepted", "fixed-payer-lowercase",
    "issuedAt may trail receipt by 30 seconds.", { issuedAt: AT.quoteReceived - 30, validBefore: AT.quoteReceived - 30 + 120 },
    { verdict: "accepted" });
  await add("fixed.issued-31s-before-receipt.rejected", "fixed-payer-lowercase",
    "issuedAt may not trail receipt by 31 seconds.", { issuedAt: AT.quoteReceived - 31, validBefore: AT.quoteReceived - 31 + 120 },
    unavailable);
  await add("fixed.issued-30s-after-receipt.accepted", "fixed-payer-lowercase",
    "issuedAt may lead receipt by 30 seconds.", { issuedAt: AT.quoteReceived + 30, validBefore: AT.quoteReceived + 30 + 120 },
    { verdict: "accepted" });
  await add("fixed.issued-31s-after-receipt.rejected", "fixed-payer-lowercase",
    "issuedAt may not lead receipt by 31 seconds.", { issuedAt: AT.quoteReceived + 31, validBefore: AT.quoteReceived + 31 + 120 },
    unavailable);
  await add("fixed.price-differs.rejected", "fixed-payer-lowercase", "A fixed listing's quote must carry its fixed gross amount.",
    { grossAmount: "250001" }, unavailable);
  await add("fixed.signed-by-terminal-key.rejected", "fixed-payer-lowercase", "Quotes are signed by the provider authority key.",
    { signer: "providerTerminalAttestation" }, unavailable);
  await add("fixed.changed-after-signing.rejected", "fixed-payer-lowercase",
    "The signature covers all seven quote fields.",
    { response: (body) => json(200, { ...body, validBefore: AT.quote + 119 }) }, unavailable);
  await add("fixed.request-hash-differs.rejected", "fixed-payer-lowercase", "The quote must bind the request hash it was asked for.",
    { patch: { requestHash: canonicalHash({ title: "another request" }) } }, unavailable);
  await add("fixed.listing-hash-differs.rejected", "fixed-payer-lowercase", "The quote must bind the listing manifest hash.",
    { patch: { listingManifestHash: LISTINGS.dynamic.listingManifestHash } }, unavailable);
  await add("fixed.extra-key.rejected", "fixed-payer-lowercase", "Exactly eight keys: an unsigned extra key is refused.",
    { response: (body) => json(200, { ...body, currency: "USDC" }) },
    { verdict: "rejected", code: "INTERNAL_ERROR", message: "provider quote response fields are invalid" });
  await add("fixed.duplicate-key.rejected", "fixed-payer-lowercase", "A body with a duplicate key is refused.",
    { response: (body) => raw(200, `{"grossAmount":"1",${JSON.stringify(body).slice(1)}`, OK) },
    { verdict: "rejected", message: "Duplicate JSON key grossAmount" });
  await add("fixed.compressed.rejected", "fixed-payer-lowercase", "A compressed body is refused before it is read.",
    { response: (body) => ({ ...json(200, body, { "content-encoding": "gzip" }), bodyEncoding: "gzip" }) },
    { verdict: "rejected", message: "BOUNDED_JSON_MEDIA_TYPE_INVALID" });
  await add("fixed.text-plain.rejected", "fixed-payer-lowercase", "Only application/json is read.",
    { response: (body) => raw(200, JSON.stringify(body), { "content-type": "text/plain" }) },
    { verdict: "rejected", message: "BOUNDED_JSON_MEDIA_TYPE_INVALID" });
  await add("dynamic.accepted", "dynamic-payer-lowercase", "A dynamic quote may last its policy's 180 seconds.",
    { grossAmount: "400000", validBefore: AT.quote + 180 }, { verdict: "accepted" }, FULL);
  await add("dynamic.lifetime-181.rejected", "dynamic-payer-lowercase", "A dynamic quote may not outlast its policy.",
    { grossAmount: "400000", validBefore: AT.quote + 181 }, unavailable, FULL);
  await add("dynamic.minimum-releasable.accepted", "dynamic-payer-lowercase",
    "At 500 bps the smallest releasable gross amount is 20 atomic units.", { grossAmount: "20" }, { verdict: "accepted" }, FULL);
  await add("dynamic.below-minimum-releasable.rejected", "dynamic-payer-lowercase",
    "19 atomic units cannot be released at 500 bps.", { grossAmount: "19" }, unavailable, FULL);
  const refusals: Doc[] = [
    { id: "refusal.field-errors", request: "fixed-payer-lowercase", appliesTo: STARTERS,
      purpose: "A 4xx with structured fieldErrors declines the request before any payment.",
      response: json(422, { fieldErrors: [{ path: "/title", rule: "maxLength", message: "Title is too long." }] }),
      gateway: { receivedAt: AT.quoteReceived, verdict: "rejected", code: "PROVIDER_QUOTE_REJECTED",
        fieldErrors: [{ path: "/title", rule: "maxLength", message: "Title is too long." }] } },
    { id: "refusal.unavailable", request: "fixed-payer-lowercase", appliesTo: STARTERS,
      purpose: "Any 5xx is an unavailable quote, never a decline.", response: raw(503, ""),
      gateway: { receivedAt: AT.quoteReceived, verdict: "rejected", code: "PROVIDER_QUOTE_UNAVAILABLE" } },
  ];
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    surface: "POST quoteUrl with {request: ProviderQuoteRequestV1}; answer {outcomeId, listingManifestHash, " +
      "requestHash, grossAmount, payer, issuedAt, validBefore, signature}",
    signature: "EIP-191 by the provider authority key over keccak256(canonicalJson of the seven unsigned fields)",
    requests: Object.fromEntries(Object.entries(story.quotes).map(([name, value]) => [name, {
      listing: value.listing, gateway: { now: value.now }, http: value.http,
      ...(name === "fixed-payer-lowercase" ? { issuedQuoteV1: value.quote } : {}),
    }])),
    responses: [...vectors, ...refusals],
    notes: [
      "The accepted fixed-payer-lowercase answer is the one the order in context.json was issued from: " +
        `QuoteV1.providerQuoteHash ${fixed.quote.payload.providerQuoteHash} is its hash.`,
    ],
  };
}

async function intakeDocument(story: Story): Promise<Doc> {
  const request = story.intake.http.body.request as { payload: { outcomeId: string; listingManifestHash: Hex; requestHash: Hex } };
  const vectors: Doc[] = [];
  const add = async (id: string, purpose: string, patch: Doc, gateway: Doc, signer: KeyName = "providerAuthority",
    response?: (body: Doc) => WireResponse) => {
    const payload = {
      outcomeId: request.payload.outcomeId, listingManifestHash: request.payload.listingManifestHash,
      requestHash: request.payload.requestHash, requestSchema: REQUEST_SCHEMA, requiredFields: {}, selectorsRequired: [],
      normalizedSelectors: {}, fieldErrors: [], supported: true, issuedAt: AT.intake, validBefore: AT.intake + 60, ...patch,
    };
    const body = { ...payload, signature: await providerSign(signer, payload) };
    vectors.push({ id, request: "intake", appliesTo: STARTERS, purpose, provider: { now: AT.intake, signer, ...payload },
      response: response ? response(body) : json(200, body), gateway: { receivedAt: AT.intake, ...gateway } });
  };
  const unavailable = { verdict: "rejected", code: "PROVIDER_INTAKE_UNAVAILABLE" };
  await add("accepted", "Signed intake requirements bound to the request, the listing and its published request schema.", {},
    { verdict: "accepted" });
  await add("schema-differs.rejected", "The published request schema stays authoritative.",
    { requestSchema: { ...REQUEST_SCHEMA, required: [] } }, unavailable);
  await add("expired.rejected", "validBefore must lie after the gateway's clock.", { validBefore: AT.intake }, unavailable);
  await add("lifetime-121.rejected", "Intake answers last at most 120 seconds.", { validBefore: AT.intake + 121 }, unavailable);
  await add("request-hash-differs.rejected", "The answer must bind the request hash.",
    { requestHash: canonicalHash({ title: "another request" }) }, unavailable);
  await add("signed-by-terminal-key.rejected", "Intake is signed by the provider authority key.", {}, unavailable,
    "providerTerminalAttestation");
  await add("extra-key.rejected", "Exactly the twelve intake keys.", {}, unavailable, "providerAuthority",
    (body) => json(200, { ...body, note: "extra" }));
  vectors.push({ id: "refusal.unavailable", request: "intake", appliesTo: STARTERS,
    purpose: "Any non-2xx leaves intake unavailable.", response: json(503, { error: "intake_unavailable" }),
    gateway: { receivedAt: AT.intake, ...unavailable } });
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    surface: "POST quoteUrl with {request: ProviderIntakeRequestV1}; answer the twelve intake keys",
    signature: "EIP-191 by the provider authority key over keccak256(canonicalJson of the answer without signature)",
    requests: { intake: { listing: "fixed", gateway: { now: story.intake.now }, http: story.intake.http } },
    responses: vectors,
  };
}

// ---------------------------------------------------------------------------
// Dispatch and dispatch status.

const resultHash = (result: unknown): Hex => canonicalHash(result);
const STYLE_RESULTS = {
  serviceResult: RESULTS.serviceResult.completed,
  taskProjection: RESULTS.taskProjection.completed,
} as const;

/** The answer a provider gives for an admitted dispatch, with the inputs it was built from. */
async function admitted(args: {
  dispatchHash: Hex; state: string; now: number; operations?: unknown;
  terminal?: { result: unknown; completedAt: number };
}, keys: { authority?: KeyName; terminal?: KeyName } = {}) {
  const operations = args.operations ?? operationsView(0, args.now);
  const terminal = args.terminal
    ? { resultHash: resultHash(args.terminal.result), completedAt: args.terminal.completedAt } : undefined;
  const body = await dispatchBody({ taskId: TASK_ID, dispatchHash: args.dispatchHash, state: args.state, operations,
    ...(terminal ? { terminal } : {}) }, keys);
  const provider = {
    now: args.now, taskId: TASK_ID, state: args.state, operations,
    ...(args.terminal ? { result: args.terminal.result, ...terminal } : {}),
    signer: keys.authority ?? "providerAuthority",
    ...(terminal ? { terminalSigner: keys.terminal ?? "providerTerminalAttestation" } : {}),
  };
  return { body, provider };
}

async function dispatchDocument(story: Story): Promise<Doc> {
  const { dispatchHash } = story.dispatches.initial!;
  const now = AT.dispatchAnswered;
  const vectors: Doc[] = [];
  const add = (id: string, purpose: string, provider: Doc, response: WireResponse, gateway: Doc,
    appliesTo: readonly string[] = STARTERS) =>
    vectors.push({ id, request: "initial", appliesTo, purpose, provider, response,
      gateway: { orderState: "RELEASE_FINAL", receivedAt: now, ...gateway } });
  const accepted = (orderStateAfter: string) => ({ verdict: "accepted", orderStateAfter, providerTaskId: TASK_ID });
  const ambiguous = { verdict: "ambiguous", orderStateAfter: "DISPATCH_AMBIGUOUS" };
  const sync = { result: RESULTS.serviceResult.completed, completedAt: now };
  for (const [state, orderState, appliesTo] of [
    ["submitted", "DISPATCHED", STARTERS], ["working", "DISPATCHED", STARTERS], ["input-required", "INPUT_REQUIRED", FULL],
  ] as const) {
    const answer = await admitted({ dispatchHash, state, now });
    add(`${state}.accepted`, `An admitted dispatch answered ${state}: no attestation, all-null operations at revision 0.`,
      answer.provider, json(200, answer.body), accepted(orderState), appliesTo);
  }
  const completed = await admitted({ dispatchHash, state: "completed", now, terminal: sync });
  add("completed.accepted", "A synchronous completion: the dispatch attestation binds the frozen result's hash; the result itself is not inline.",
    completed.provider, json(200, completed.body), accepted("FULFILLED"), LITE);
  const failed = await admitted({ dispatchHash, state: "failed", now,
    terminal: { result: RESULTS.serviceResult.failed, completedAt: now } });
  add("failed.accepted", "A synchronous failure is attested like a completion.", failed.provider, json(200, failed.body),
    accepted("PROVIDER_FAILED"), LITE);
  for (const [age, verdict] of [[300, accepted("DISPATCHED")], [301, ambiguous], [-30, accepted("DISPATCHED")], [-31, ambiguous]] as const) {
    const answer = await admitted({ dispatchHash, state: "working", now, operations: operationsView(0, now - age) });
    const label = age >= 0 ? `operations-${age}s-old` : `operations-${-age}s-ahead`;
    add(`${verdict.verdict === "accepted" ? "accepted" : "rejected"}.${label}`,
      `Operations observed ${age >= 0 ? `${age} s before` : `${-age} s after`} receipt are ${verdict.verdict === "accepted" ? "fresh" : "refused"}.`,
      answer.provider, json(200, answer.body), verdict);
  }
  for (const [id, purpose, status, body] of [
    ["refused.quote-window", "A definite refusal before any admission: the gateway records it and later sends a fresh envelope.",
      409, { error: "dispatch_rejected", reason: "quote_window" }],
    ["refused.service-unavailable", "A synchronous provider that cannot execute yet refuses before admission.",
      503, { error: "dispatch_rejected", reason: "service_unavailable" }],
  ] as const) {
    add(id, purpose, { now }, json(status, body),
      { verdict: "refused", orderStateAfter: "DISPATCH_STARTED", refusal: { status, reason: body.error } });
  }
  for (const [id, purpose, response] of [
    ["ambiguous.empty-503", "An empty 503 is the deliberate ambiguous answer: the gateway polls status for the original hash.", raw(503, "")],
    ["ambiguous.json-without-error", "JSON without an error key proves nothing.", json(500, { message: "internal" })],
    ["ambiguous.null-error", "A null error proves nothing.", json(500, { error: null })],
    ["ambiguous.edge-page", "An edge or proxy page proves nothing.", raw(502, "<html>Bad gateway</html>", { "content-type": "text/html" })],
    ["ambiguous.error-with-200", "A 2xx carrying an error is not a refusal and not a valid answer.", json(200, { error: "dispatch_rejected" })],
  ] as const) add(id, purpose, { now }, response, ambiguous);
  const working = await admitted({ dispatchHash, state: "working", now });
  const signedWorking = (fields: Doc, keys: { authority?: KeyName } = {}) =>
    dispatchBody({ taskId: TASK_ID, dispatchHash, state: "working", operations: operationsView(0, now), ...fields } as never, keys);
  const rejected: Array<[string, string, Promise<WireResponse> | WireResponse]> = [
    ["rejected.executing-state", "The internal executing state is never a wire state.",
      signedWorking({ state: "executing" }).then((body) => json(200, body))],
    ["rejected.inline-result", "A dispatch answer never carries the result inline.",
      Promise.resolve(json(200, { ...completed.body, result: RESULTS.serviceResult.completed }))],
    ["rejected.extra-key", "Exactly the accepted keys.", Promise.resolve(json(200, { ...working.body, note: "extra" }))],
    ["rejected.missing-operations", "operations is required.",
      Promise.resolve(json(200, Object.fromEntries(Object.entries(working.body).filter(([key]) => key !== "operations"))))],
    ["rejected.terminal-without-attestation", "A terminal state requires its attestation.",
      Promise.resolve(json(200, Object.fromEntries(Object.entries(completed.body).filter(([key]) => key !== "terminalAttestation"))))],
    ["rejected.attestation-on-pending", "Only terminal states carry an attestation.",
      Promise.resolve(json(200, { ...working.body, terminalAttestation: completed.body.terminalAttestation }))],
    ["rejected.other-dispatch-hash", "The answer must name the dispatch hash it was asked for.",
      admitted({ dispatchHash: story.dispatches["retry-after-refusal"]!.dispatchHash, state: "working", now })
        .then((answer) => json(200, answer.body))],
    ["rejected.signed-by-terminal-key", "The answer is signed by the provider authority key.",
      signedWorking({}, { authority: "providerTerminalAttestation" }).then((body) => json(200, body))],
    ["rejected.state-changed-after-signing", "The signature covers taskId, dispatchHash, state and operations.",
      Promise.resolve(json(200, { ...working.body, state: "submitted" }))],
    ["rejected.operations-changed-after-signing", "The signature covers the operations.",
      Promise.resolve(json(200, { ...working.body, operations: operationsView(1, now) }))],
    ["rejected.task-id-too-long", "taskId is 1 to 128 characters.",
      dispatchBody({ taskId: "t".repeat(129), dispatchHash, state: "working", operations: operationsView(0, now) })
        .then((body) => json(200, body))],
    ["rejected.attestation-signed-by-authority-key", "Terminal attestations are signed by the terminal attestation key.",
      admitted({ dispatchHash, state: "completed", now, terminal: sync }, { terminal: "providerAuthority" })
        .then((answer) => json(200, answer.body))],
    ["rejected.attestation-for-other-state", "The attestation names the answer's state.",
      admitted({ dispatchHash, state: "failed", now, terminal: sync })
        .then((answer) => json(200, { ...completed.body, terminalAttestation: answer.body.terminalAttestation }))],
    ["rejected.attestation-completed-in-future", "completedAt may lead the gateway's clock by at most 30 seconds.",
      admitted({ dispatchHash, state: "completed", now, terminal: { ...sync, completedAt: now + 31 } })
        .then((answer) => json(200, answer.body))],
    ["rejected.attestation-changed-after-signing", "The attestation signature covers its whole payload.",
      Promise.resolve(json(200, { ...completed.body, terminalAttestation: {
        ...(completed.body.terminalAttestation as Doc),
        payload: { ...((completed.body.terminalAttestation as Doc).payload as Doc), resultHash: resultHash({ altered: true }) },
      } }))],
    ["rejected.lifecycle-form-attestation", "Cross-type reuse: a lifecycle attestation (orderId instead of dispatchHash) is not a dispatch attestation.",
      lifecycleBody({ orderId: ORDER_ID, taskId: TASK_ID, state: "completed", operations: operationsView(0, now),
        terminal: { resultHash: resultHash(sync.result), completedAt: now } })
        .then((body) => json(200, { ...completed.body, terminalAttestation: body.terminalAttestation }))],
    ["rejected.quote-answer-reused", "Cross-type reuse: a signed quote answer is not a dispatch answer.",
      Promise.resolve(json(200, story.quotes["fixed-payer-lowercase"]!.providerQuote))],
    ["rejected.duplicate-key", "A body with a duplicate key is refused.",
      Promise.resolve(raw(200, `{"state":"completed",${JSON.stringify(working.body).slice(1)}`, OK))],
    ["rejected.compressed", "A compressed body is refused before it is read.",
      Promise.resolve({ ...json(200, working.body, { "content-encoding": "gzip" }), bodyEncoding: "gzip" as const })],
    ["rejected.text-plain", "Only application/json is read.",
      Promise.resolve(raw(200, JSON.stringify(working.body), { "content-type": "text/plain" }))],
  ];
  for (const [id, purpose, response] of rejected) add(id, purpose, { now }, await response, ambiguous);
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    surface: "POST dispatchUrl with {dispatch: StandardRailDispatchV2, quote: QuoteV1, request, " +
      "evidenceBundle}; answer {taskId, dispatchHash, signature, state, operations} plus " +
      "terminalAttestation for completed, failed and canceled",
    signature: "signature: EIP-191 by the provider authority key over keccak256(canonicalJson({taskId, " +
      "dispatchHash, state, operations})); terminalAttestation.signature: EIP-191 by the terminal " +
      "attestation key over keccak256(canonicalJson(payload)), payload {taskId, dispatchHash, state, " +
      "resultHash, completedAt}",
    verdicts: {
      accepted: "The gateway resolves the dispatch to the task and moves the order to orderStateAfter.",
      refused: "Definite refusal before admission: the gateway records it and later sends a fresh envelope with a new nonce.",
      ambiguous: "The gateway cannot trust the answer and polls dispatch status for the original dispatch hash.",
    },
    requests: Object.fromEntries(Object.entries(story.dispatches).map(([name, value]) => [name, {
      purpose: {
        initial: "The first dispatch of the paid order in context.json.",
        "retry-after-refusal": "After a definite refusal the gateway sends a fresh envelope for the same order: new nonce, " +
          "issuedAt and dispatch hash, the same QuoteV1.",
        "delayed-first-dispatch": "A timely-paid order dispatched for the first time 26 hours after its quote expired, inside the " +
          "snapshot's recovery window; the QuoteV1 is unchanged.",
      }[name], gateway: { now: value.now }, dispatchHash: value.dispatchHash, http: value.http,
    }])),
    responses: vectors,
  };
}

async function statusDocument(story: Story): Promise<Doc> {
  const { dispatchHash } = story.dispatches.initial!;
  const vectors: Doc[] = [];
  const add = (id: string, request: string, purpose: string, provider: Doc, response: WireResponse, gateway: Doc,
    appliesTo: readonly string[] = STARTERS) =>
    vectors.push({ id, request, appliesTo, purpose, provider, response,
      gateway: { orderState: "DISPATCH_AMBIGUOUS", receivedAt: story.statuses[request]!.now, ...gateway } });
  const working = await admitted({ dispatchHash, state: "working", now: AT.statusWorking });
  add("working.accepted", "working", "The admitted snapshot for the queried hash, observed and signed afresh.",
    working.provider, json(200, working.body), { verdict: "accepted", orderStateAfter: "DISPATCHED" });
  for (const [style, appliesTo] of [["serviceResult", LITE], ["taskProjection", FULL]] as const) {
    const answer = await admitted({ dispatchHash, state: "completed", now: AT.statusCompleted,
      terminal: { result: STYLE_RESULTS[style], completedAt: AT.completed } });
    add(style === "serviceResult" ? "completed.accepted" : "completed-task.accepted", "completed",
      `A completion polled from status; the attestation binds the hash of the frozen ${style === "serviceResult"
        ? "service result" : "unrevealed task projection"}.`,
      answer.provider, json(200, answer.body), { verdict: "accepted", orderStateAfter: "FULFILLED" }, appliesTo);
  }
  const failed = await admitted({ dispatchHash, state: "failed", now: AT.statusCompleted,
    terminal: { result: RESULTS.serviceResult.failed, completedAt: AT.completed } });
  add("failed.accepted", "completed", "A failure polled from status.", failed.provider, json(200, failed.body),
    { verdict: "accepted", orderStateAfter: "PROVIDER_FAILED" }, LITE);
  const noClaim = { error: "dispatch_status_unavailable", reason: "outcome_policy" };
  add("no-claim.within-grace", "no-claim-within-grace",
    "The provider proves it holds no claim; before the envelope's validBefore plus 60 seconds the gateway keeps polling.",
    { now: AT.noClaimWithinGrace, claim: null }, json(404, noClaim), { verdict: "noClaim", refusalRecorded: false });
  add("no-claim.after-grace", "no-claim-after-grace",
    "From validBefore plus 60 seconds the no-claim answer is recorded and a fresh envelope follows.",
    { now: AT.noClaimAfterGrace, claim: null }, json(404, noClaim),
    { verdict: "noClaim", refusalRecorded: true, refusal: { status: 404, reason: { source: "dispatch_status", ...noClaim } } });
  const other = await admitted({ dispatchHash: story.dispatches["retry-after-refusal"]!.dispatchHash, state: "working",
    now: AT.noClaimAfterGrace });
  for (const [id, purpose, response] of [
    ["unknown.no-reason", "A 404 without reason outcome_policy never proves absence.", json(404, { error: "dispatch_status_unavailable" })],
    ["unknown.other-reason", "Signature, clock and internal failures must not use outcome_policy.",
      json(404, { error: "dispatch_status_unavailable", reason: "signature" })],
    ["unknown.null-error", "A null error proves nothing.", json(404, { error: null, reason: "outcome_policy" })],
    ["unknown.not-json", "An edge 404 page proves nothing.", raw(404, "Not Found", { "content-type": "text/plain" })],
    ["unknown.empty-503", "An empty 503 leaves the dispatch unknown.", raw(503, "")],
    ["unknown.outcome-policy-at-500", "Only a 404 can carry the no-claim answer.", json(500, noClaim)],
    ["unknown.answer-for-other-dispatch", "An answer for another dispatch hash is not an answer for this one.", json(200, other.body)],
  ] as const) {
    add(id, "no-claim-after-grace", purpose, { now: AT.noClaimAfterGrace }, response, { verdict: "unknown" });
  }
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    surface: "POST dispatchStatusUrl with {query: DispatchStatusQueryV1}; answer exactly like the dispatch for " +
      "the queried hash, or 404 " +
      "{\"error\":\"dispatch_status_unavailable\",\"reason\":\"outcome_policy\"} only when an " +
      "authoritative lookup finds no claim for the order",
    verdicts: {
      accepted: "The gateway resolves the dispatch and moves the order from DISPATCH_AMBIGUOUS to orderStateAfter.",
      noClaim: "The gateway records the absence only from the original envelope's validBefore plus 60 seconds, then sends a fresh envelope.",
      unknown: "The gateway keeps the order DISPATCH_AMBIGUOUS and polls again; it never drops the claim.",
    },
    requests: Object.fromEntries(Object.entries(story.statuses).map(([name, value]) => [name, {
      gateway: { now: value.now }, dispatchHash, http: value.http,
    }])),
    responses: vectors,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle and terminal evidence.

async function lifecycleVectors(story: Story, kind: "lifecycle" | "terminal"): Promise<Doc[]> {
  const stored = {
    serviceResult: await statusTerminal(story, "serviceResult"),
    taskProjection: await statusTerminal(story, "taskProjection"),
  };
  const vectors: Doc[] = [];
  const add = async (id: string, request: string, purpose: string, args: {
    state: string; now?: number; operations?: unknown; result?: unknown; terminal?: { result: unknown; completedAt: number };
    attestationResultHash?: Hex; keys?: { authority?: KeyName; terminal?: KeyName }; orderId?: string;
    response?: (body: Doc) => WireResponse | Promise<WireResponse>;
  }, gateway: Doc & { stored?: keyof typeof stored | null; resultSchema?: "serviceResult" | "taskProjection" },
  appliesTo: readonly string[] = STARTERS) => {
    const source = story.lifecycles[request]!;
    const now = args.now ?? source.now;
    const operations = args.operations ?? operationsView(0, now);
    const terminal = args.terminal ? {
      resultHash: args.attestationResultHash ?? resultHash(args.terminal.result), completedAt: args.terminal.completedAt,
    } : undefined;
    const body = await lifecycleBody({ orderId: args.orderId ?? ORDER_ID, taskId: TASK_ID, state: args.state, operations,
      ...(args.result !== undefined ? { result: args.result } : {}), ...(terminal ? { terminal } : {}) }, args.keys);
    const { stored: storedStyle = source.orderState === "FULFILLED" ? "serviceResult" : null, resultSchema, ...verdict } = gateway;
    const before = storedStyle ? stored[storedStyle] : null;
    vectors.push({
      id, request, appliesTo, purpose,
      provider: { now, orderId: args.orderId ?? ORDER_ID, taskId: TASK_ID, state: args.state, operations,
        ...(args.result !== undefined ? { result: args.result } : {}),
        ...(terminal ? { frozenResult: args.terminal!.result, ...terminal } : {}) },
      response: args.response ? await args.response(body) : json(200, body),
      gateway: {
        orderState: source.orderState, resultSchema: resultSchema ?? "serviceResult",
        storedOperations: before?.operations ?? null, storedTerminal: before?.terminal ?? null,
        receivedAt: now, ...verdict,
      },
    });
  };
  const sr = { result: RESULTS.serviceResult.completed, completedAt: AT.completed };
  const tp = { result: RESULTS.taskProjection.completed, completedAt: AT.completed };
  const accepted = (orderStateAfter: string) => ({ verdict: "accepted", orderStateAfter });
  const internal = (message: string) => ({ verdict: "rejected", code: "INTERNAL_ERROR", message });
  if (kind === "terminal") {
    await add("service-result.lifecycle-attestation.accepted", "status.read-capability.completed",
      "The lifecycle attestation names orderId instead of dispatchHash; taskId, state, resultHash and completedAt equal the dispatch attestation.",
      { state: "completed", terminal: sr }, accepted("FULFILLED"), LITE);
    await add("service-result.rehashed.rejected", "status.read-capability.completed",
      "A result hash recomputed after completion is a changed terminal identity.",
      { state: "completed", terminal: sr, attestationResultHash: resultHash({ ...sr.result, message: "Note created again." }) },
      { verdict: "rejected", message: "provider_original_terminal_changed" }, LITE);
    await add("service-result.completion-moved.rejected", "status.read-capability.completed",
      "completedAt is part of the terminal identity.", { state: "completed", terminal: { ...sr, completedAt: AT.completed + 1 } },
      { verdict: "rejected", message: "provider_original_terminal_changed" }, LITE);
    await add("service-result.state-changed.rejected", "status.read-capability.completed",
      "A completed order never becomes failed.", { state: "failed", terminal: sr },
      { verdict: "rejected", message: "provider_original_terminal_changed" }, LITE);
    await add("task-projection.after-support-message.accepted", "status.payer-signed.completed",
      "A support message changes operations (higher revision) but never the terminal identity.",
      { state: "completed", terminal: tp, operations: operationsView(1, AT.lifecycleCompleted, { support: {
        reviewId: SUPPORT.reviewId, status: "open",
        lastAcceptedRequest: { requestId: SUPPORT.requestId, messageId: SUPPORT.messageId, acceptedAt: AT.support - 300 },
      } }) },
      { stored: "taskProjection", ...accepted("FULFILLED") }, FULL);
    await add("task-projection.revealed-hash.rejected", "status.payer-signed.completed",
      "The attestation keeps the frozen unrevealed projection's hash; the revealed representation's hash is a changed identity.",
      { state: "completed", terminal: tp, attestationResultHash: resultHash(RESULTS.taskProjection.revealed) },
      { stored: "taskProjection", verdict: "rejected", message: "provider_original_terminal_changed" }, FULL);
    await add("task-projection.reconstructed.rejected", "status.payer-signed.completed",
      "A projection rebuilt from mutable events after cleanup hashes differently: serve the frozen identity instead.",
      { state: "completed", terminal: tp, attestationResultHash: resultHash({ ...RESULTS.taskProjection.completed,
        status: { state: "TASK_STATE_COMPLETED", message: { role: "ROLE_AGENT", parts: [] } } }) },
      { stored: "taskProjection", verdict: "rejected", message: "provider_original_terminal_changed" }, FULL);
    return vectors;
  }
  await add("status.working.accepted", "status.read-capability.working", "Status of a working order: signed, no result, no attestation.",
    { state: "working" }, accepted("DISPATCHED"));
  await add("status.completed.accepted", "status.read-capability.completed",
    "Status of a completed order carries the lifecycle attestation and no result.",
    { state: "completed", terminal: sr }, accepted("FULFILLED"), LITE);
  await add("status.completed-task.accepted", "status.payer-signed.completed",
    "Payer-signed status of a completed full order.", { state: "completed", terminal: tp },
    { stored: "taskProjection", ...accepted("FULFILLED") }, FULL);
  await add("artifact.service-result.accepted", "artifact.read-capability.completed",
    "The artifact is the frozen service result itself; its hash equals the attested resultHash.",
    { state: "completed", result: sr.result, terminal: sr }, accepted("FULFILLED"), LITE);
  await add("artifact.protected-reveal.accepted", "artifact.payer-signed.completed",
    "The artifact reveals protected fields; the attestation keeps the frozen unrevealed projection's hash.",
    { state: "completed", result: RESULTS.taskProjection.revealed, terminal: tp },
    { stored: "taskProjection", resultSchema: "taskProjection", ...accepted("FULFILLED") }, FULL);
  const supportOps = operationsView(1, AT.support, { support: { reviewId: SUPPORT.reviewId, status: "open",
    lastAcceptedRequest: { requestId: SUPPORT.requestId, messageId: SUPPORT.messageId, acceptedAt: AT.support } } });
  const receipt = { supportReceipt: { requestId: SUPPORT.requestId, messageId: SUPPORT.messageId,
    reviewId: SUPPORT.reviewId, acceptedAt: iso(AT.support) } };
  await add("support.receipt.accepted", "support.payer-signed",
    "A support message accepted after completion: a receipt, a higher operations revision, the same terminal identity.",
    { state: "completed", operations: supportOps, result: receipt, terminal: tp },
    { stored: "taskProjection", ...accepted("FULFILLED") }, FULL);
  await add("input.working.accepted", "input.payer-signed", "Buyer input accepted: the order works again.",
    { state: "working" }, accepted("DISPATCHED"), FULL);
  await add("cancel.canceled.accepted", "cancel.payer-signed", "A cancellation is terminal and attested; it carries no result.",
    { state: "canceled", terminal: { result: RESULTS.taskProjection.canceled, completedAt: AT.midway } },
    accepted("PROVIDER_FAILED"), FULL);
  await add("status.inline-result.rejected", "status.read-capability.completed", "Status never delivers the artifact.",
    { state: "completed", result: sr.result, terminal: sr }, internal("PROVIDER_LIFECYCLE_UNEXPECTED_CONTENT"));
  await add("status.other-order.rejected", "status.read-capability.working", "The answer names the order it was asked about.",
    { state: "working", orderId: "ord_00000000-0000-4000-8000-000000000002" }, internal("PROVIDER_LIFECYCLE_BINDING_INVALID"));
  await add("status.executing-state.rejected", "status.read-capability.working", "executing is never a wire state.",
    { state: "executing" }, internal("PROVIDER_LIFECYCLE_BINDING_INVALID"));
  await add("status.signed-by-terminal-key.rejected", "status.read-capability.working",
    "Lifecycle answers are signed by the provider authority key.",
    { state: "working", keys: { authority: "providerTerminalAttestation" } }, internal("PROVIDER_LIFECYCLE_SIGNATURE_INVALID"));
  await add("status.changed-after-signing.rejected", "status.read-capability.working",
    "The signature covers every key but signature.", { state: "working", response: (body) => json(200, { ...body, state: "submitted" }) },
    internal("PROVIDER_LIFECYCLE_SIGNATURE_INVALID"));
  await add("status.extra-key.rejected", "status.read-capability.working", "No unversioned extra keys.",
    { state: "working", response: (body) => json(200, { ...body, note: "extra" }) },
    internal("provider lifecycle response fields are invalid"));
  await add("status.operations-301s-old.rejected", "status.read-capability.working", "Operations are observed afresh for every answer.",
    { state: "working", operations: operationsView(0, AT.midway - 301) },
    { verdict: "rejected", message: "provider_operations_observation_stale" });
  await add("status.operations-31s-ahead.rejected", "status.read-capability.working", "Operations may lead by at most 30 seconds.",
    { state: "working", operations: operationsView(0, AT.midway + 31) },
    { verdict: "rejected", message: "provider_operations_observation_stale" });
  await add("status.completed-without-attestation.rejected", "status.read-capability.completed",
    "A terminal state requires the lifecycle attestation.", { state: "completed" },
    internal("PROVIDER_TERMINAL_ATTESTATION_MISSING"));
  await add("status.dispatch-attestation.rejected", "status.read-capability.completed",
    "Cross-type reuse: the dispatch attestation (dispatchHash instead of orderId) is not a lifecycle attestation.",
    { state: "completed", terminal: sr, response: async (body) => {
      const { signature: _signature, ...unsigned } = body;
      const reused = { ...unsigned, terminalAttestation: stored.serviceResult.terminal };
      return json(200, { ...reused, signature: await providerSign("providerAuthority", reused) });
    } }, internal("provider lifecycle attestation payload fields are invalid"));
  await add("status.dispatch-answer-reused.rejected", "status.read-capability.completed",
    "Cross-type reuse: a signed dispatch answer is not a lifecycle answer.",
    { state: "completed", terminal: sr, response: () => json(200, stored.serviceResult.body) },
    internal("provider lifecycle response fields are invalid"));
  await add("status.duplicate-key.rejected", "status.read-capability.working", "A body with a duplicate key is refused.",
    { state: "working", response: (body) => raw(200, `{"state":"completed",${JSON.stringify(body).slice(1)}`, OK) },
    { verdict: "rejected", message: "Duplicate JSON key state" });
  await add("status.compressed.rejected", "status.read-capability.working", "A compressed body is refused before it is read.",
    { state: "working", response: (body) => ({ ...json(200, body, { "content-encoding": "gzip" }), bodyEncoding: "gzip" }) },
    { verdict: "rejected", message: "BOUNDED_JSON_MEDIA_TYPE_INVALID" });
  await add("artifact.not-completed.rejected", "artifact.read-capability.working",
    "An artifact is delivered only for a completed order.", { state: "working", result: sr.result },
    internal("PROVIDER_ARTIFACT_NOT_FULFILLED"));
  await add("artifact.missing-result.rejected", "artifact.read-capability.completed", "An artifact answer carries the result.",
    { state: "completed", terminal: sr }, internal("PROVIDER_ARTIFACT_MISSING"), LITE);
  await add("artifact.outside-schema.rejected", "artifact.read-capability.completed",
    "The artifact is validated against the checkout snapshot's result schema.",
    { state: "completed", result: { ...sr.result, status: "done" }, terminal: sr },
    { verdict: "rejected", message: "Response does not match the closed outcome schema" }, LITE);
  await add("artifact.other-task.rejected", "artifact.payer-signed.completed", "A task-shaped result names the order's task.",
    { state: "completed", result: { ...RESULTS.taskProjection.revealed, id: "00000000-0000-4000-8000-00000000a002" }, terminal: tp },
    { stored: "taskProjection", resultSchema: "taskProjection", ...internal("PROVIDER_ARTIFACT_TASK_BINDING_INVALID") }, FULL);
  await add("support.other-request.rejected", "support.payer-signed", "The receipt names the support requestId it answers.",
    { state: "completed", operations: supportOps, terminal: tp,
      result: { supportReceipt: { ...receipt.supportReceipt, requestId: "support-0002" } } },
    { stored: "taskProjection", ...internal("PROVIDER_SUPPORT_RECEIPT_BINDING_INVALID") }, FULL);
  return vectors;
}

async function statusTerminal(story: Story, style: keyof typeof STYLE_RESULTS) {
  const answer = await admitted({ dispatchHash: story.dispatches.initial!.dispatchHash, state: "completed",
    now: AT.statusCompleted, terminal: { result: STYLE_RESULTS[style], completedAt: AT.completed } });
  return { body: answer.body, operations: answer.body.operations, terminal: answer.body.terminalAttestation as Doc };
}

function lifecycleRefusals(): Doc[] {
  const refusal = (id: string, request: string, purpose: string, response: WireResponse, gateway: Doc,
    appliesTo: readonly string[] = STARTERS) => ({ id, request, appliesTo, purpose, response, gateway });
  return [
    refusal("artifact.unavailable", "artifact.read-capability.working", "An artifact read before completion.",
      json(409, { error: "artifact_unavailable" }), { verdict: "refused", code: "ARTIFACT_NOT_AVAILABLE", status: 409 }),
    ...(["support.payer-signed", "input.payer-signed", "cancel.payer-signed"] as const).map((request) => refusal(
      `${request.split(".")[0]}.unsupported`, request, "A lite provider answers actions it does not implement, without any effect.",
      json(409, { error: "unsupported_action" }), { verdict: "refused", code: "ORDER_ACTION_UNSUPPORTED", status: 409 }, LITE)),
    refusal("support.conflict", "support.payer-signed", "The same support requestId already bound a different message.",
      json(409, { error: "action_conflict" }), { verdict: "refused", code: "ORDER_ACTION_CONFLICT", status: 409 }, FULL),
    refusal("status.unavailable.read-capability", "status.read-capability.working",
      "Temporarily unavailable: a read capability retries without a new signature.",
      json(503, { error: "lifecycle_unavailable" }),
      { verdict: "refused", code: "PROVIDER_LIFECYCLE_UNAVAILABLE", status: 503, requiresNewSignature: false }),
    refusal("cancel.unavailable.payer-signed", "cancel.payer-signed",
      "Temporarily unavailable: the spent payer authorization is not returned; a retry needs a fresh one.",
      json(503, { error: "lifecycle_unavailable" }),
      { verdict: "refused", code: "PROVIDER_LIFECYCLE_UNAVAILABLE", status: 503, requiresNewSignature: true }, FULL),
    refusal("status.artifact-unavailable.internal", "status.read-capability.working",
      "artifact_unavailable names only an artifact read.", json(409, { error: "artifact_unavailable" }),
      { verdict: "rejected", code: "INTERNAL_ERROR", message: "PROVIDER_LIFECYCLE_REJECTED" }),
    refusal("unsupported.extra-key.internal", "cancel.payer-signed", "Named refusals carry exactly one key.",
      json(409, { error: "unsupported_action", detail: "not implemented" }),
      { verdict: "rejected", code: "INTERNAL_ERROR", message: "PROVIDER_LIFECYCLE_REJECTED" }),
    refusal("unavailable.wrong-status.internal", "status.read-capability.working",
      "lifecycle_unavailable is named only at 503.", json(500, { error: "lifecycle_unavailable" }),
      { verdict: "rejected", code: "INTERNAL_ERROR", message: "PROVIDER_LIFECYCLE_REJECTED" }),
    refusal("empty-503.internal", "status.read-capability.working", "An empty 503 is an unnamed fault.", raw(503, ""),
      { verdict: "rejected", code: "INTERNAL_ERROR", message: "PROVIDER_LIFECYCLE_REJECTED" }),
  ];
}

async function lifecycleDocument(story: Story): Promise<Doc> {
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    surface: "POST lifecycleUrl with {orderId, providerTaskId, action, request, authorization, grant, payer, " +
      "gatewayAudience}; answer {orderId, taskId, state, operations, signature} plus result (artifact, " +
      "support), terminalAttestation (completed, failed, canceled) and inputRequest/documents only when " +
      "the daski-order-status-view header asks",
    signature: "signature: EIP-191 by the provider authority key over keccak256(canonicalJson(answer without " +
      "signature)), terminalAttestation included; terminalAttestation.signature: EIP-191 by the " +
      "terminal attestation key over keccak256(canonicalJson(payload)), payload {orderId, taskId, " +
      "state, resultHash, completedAt}",
    authorization: {
      readCapability: "authorization is {type: \"DaskiReadCap\", scope: action}, for status and artifact only; the " +
        "grant's authorizationHash is canonicalHash of it",
      payerSigned: "authorization is the buyer's OrderActionAuthorizationV1 (nine fields); its EIP-712 signature " +
        "recovers to the order's payer for domain {name: DaskiStandardOrder, version: 1, chainId} with " +
        "audienceHash keccak256(gatewayAudience); the grant's authorizationHash is canonicalHash of the " +
        "whole authorization",
      grant: "ProviderLifecycleGrantV1 signed by gateway-lifecycle for the provider audience, valid at most " +
        "120 seconds, payload {orderId, providerTaskId, action, requestHash, authorizationHash, payer}",
    },
    headers: (Object.values(story.lifecycles)[0] as LifecycleRequestFixture).http.headers,
    verdicts: {
      accepted: "The gateway passes the signed answer to the buyer; the order moves to orderStateAfter.",
      refused: "The gateway names the refusal to the buyer with code and status.",
      rejected: "The gateway refuses the answer; the buyer sees an internal error and the provider's text is never shown.",
    },
    requests: Object.fromEntries(Object.entries(story.lifecycles).map(([name, value]) => [name, {
      action: value.action, access: value.access, orderState: value.orderState, gateway: { now: value.now }, http: value.http,
    }])),
    responses: await lifecycleVectors(story, "lifecycle"),
    refusals: lifecycleRefusals(),
  };
}

async function terminalDocument(story: Story): Promise<Doc> {
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    rule: "The gateway stores the first terminal attestation it accepts. Every later attestation, dispatch " +
      "or lifecycle, must carry the same taskId, state, resultHash and completedAt; anything else is " +
      "provider_original_terminal_changed.",
    original: {
      serviceResult: (await statusTerminal(story, "serviceResult")).terminal,
      taskProjection: (await statusTerminal(story, "taskProjection")).terminal,
    },
    requests: "lifecycle.json",
    responses: await lifecycleVectors(story, "terminal"),
  };
}

// ---------------------------------------------------------------------------
// Operations, deadlines and request negatives.

function operationsDocument(): Doc {
  const t = AT.dispatchAnswered;
  const support = (revision: number, observedAt: number, reply?: string) => operationsView(revision, observedAt, { support: {
    reviewId: SUPPORT.reviewId, status: "open",
    lastAcceptedRequest: { requestId: SUPPORT.requestId, messageId: SUPPORT.messageId, acceptedAt: t },
    ...(reply ? { lastReply: { messageId: "00000000-0000-4000-8000-0000000000b3", repliedAt: observedAt, message: reply } } : {}),
  } });
  const step = (now: number, operations: unknown, expect: "stored" | "ignored" | string) =>
    ({ now, operations, terminal: null, ...(expect === "stored" || expect === "ignored" ? { expect } : { expect: "rejected", error: expect }) });
  const stale = "provider_operations_observation_stale";
  const conflict = "provider_operations_revision_conflict";
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    rules: [
      "operations is exactly {schemaVersion: 1, revision, observedAt, fulfillment, support, recovery}; all " +
        "three sections are required and may be null.",
      "observedAt must lie within [now - 300, now + 30] of the gateway's receipt on every dispatch, status " +
        "and lifecycle answer: stamp it afresh and re-sign; never replay a cached signed answer.",
      "A revision names exactly one semantic projection: everything except observedAt. Different content " +
        "under a stored revision is refused; changed content needs a higher revision.",
      "A lower revision, or the same revision observed earlier, is valid but ignored.",
      "An all-null projection may keep revision 0 forever; repeated fresh observations of unchanged content are stored without a new revision.",
    ],
    sequences: [
      { id: "all-null-constant-revision", appliesTo: STARTERS,
        purpose: "An unchanged pending order read after six minutes and eight hours keeps revision 0.",
        steps: [step(t, operationsView(0, t), "stored"), step(t + 360, operationsView(0, t + 360), "stored"),
          step(t + 28_800, operationsView(0, t + 28_800), "stored")] },
      ...([[0, "stored"], [300, "stored"], [301, stale], [-30, "stored"], [-31, stale]] as const).map(([age, expect]) => ({
        id: age >= 0 ? `observed-${age}s-before-receipt` : `observed-${-age}s-after-receipt`, appliesTo: STARTERS,
        purpose: "The freshness window at the gateway's receipt.", steps: [step(t, operationsView(0, t - age), expect)] })),
      { id: "same-revision-different-content", appliesTo: STARTERS, purpose: "Changed content under a stored revision is equivocation.",
        steps: [step(t, operationsView(0, t), "stored"), step(t + 60, support(0, t + 60), conflict)] },
      { id: "higher-revision-different-content", appliesTo: FULL, purpose: "Changed content takes a higher revision.",
        steps: [step(t, operationsView(0, t), "stored"), step(t + 60, support(1, t + 60), "stored"),
          step(t + 120, support(1, t + 120), "stored")] },
      { id: "lower-revision-ignored", appliesTo: FULL, purpose: "A late answer with a lower revision never replaces a newer one.",
        steps: [step(t, support(1, t), "stored"), step(t + 60, operationsView(0, t + 60), "ignored")] },
      { id: "older-observation-ignored", appliesTo: STARTERS, purpose: "A late answer observed earlier never replaces a newer one.",
        steps: [step(t + 60, operationsView(0, t + 60), "stored"), step(t + 60, operationsView(0, t + 30), "ignored")] },
      { id: "reply-is-content", appliesTo: FULL, purpose: "An operator reply is part of the projection its revision names.",
        steps: [step(t, support(2, t, "We saved your note."), "stored"),
          step(t + 60, support(2, t + 60, "We saved your note twice."), conflict)] },
    ],
  };
}

function deadlinesDocument(): Doc {
  const resolved = AT.dispatchAnswered;
  const h = 3_600;
  const probe = (at: number, servicing: number | null | "lookup-failed", providerFailed: boolean, recordedSeconds: number | null) =>
    ({ at, servicing, expect: { providerFailed, recordedSeconds } });
  const horizon = AT.releaseObserved + DEADLINE_POLICY.fulfillmentSeconds;
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    rule: "deadline = dispatch resolution + max(snapshot, recorded, current servicing duration) + admitted " +
      "prerequisite waits. A longer current duration is recorded before the deadline relies on it; " +
      "nothing shortens it. In every vector sales are paused: the sale-time listing lookup refuses and " +
      "is never asked.",
    fulfillment: [
      { id: "shorter-current-keeps-snapshot", appliesTo: STARTERS,
        purpose: "A 12-hour snapshot followed by a 6-hour listing keeps 12 hours from the original dispatch resolution.",
        order: { snapshotSeconds: 12 * h, recordedSeconds: null, purchaseReadiness: null }, resolvedAt: resolved, operations: null,
        probes: [probe(resolved + 12 * h - 1, 6 * h, false, null), probe(resolved + 12 * h, 6 * h, true, null)] },
      { id: "longer-current-is-recorded", appliesTo: STARTERS,
        purpose: "A 24-hour listing extends a 12-hour snapshot; a later 6-hour listing or a missing one cannot retract it.",
        order: { snapshotSeconds: 12 * h, recordedSeconds: null, purchaseReadiness: null }, resolvedAt: resolved, operations: null,
        probes: [probe(resolved + 12 * h, 24 * h, false, 24 * h), probe(resolved + 24 * h - 1, 6 * h, false, 24 * h),
          probe(resolved + 24 * h, null, true, 24 * h)] },
      { id: "recorded-survives-lookup-failure", appliesTo: STARTERS,
        purpose: "After a restart the recorded 24 hours hold while the servicing lookup fails.",
        order: { snapshotSeconds: 12 * h, recordedSeconds: 24 * h, purchaseReadiness: null }, resolvedAt: resolved, operations: null,
        probes: [probe(resolved + 24 * h - 1, "lookup-failed", false, 24 * h), probe(resolved + 24 * h, "lookup-failed", true, 24 * h)] },
      { id: "admitted-wait-is-excluded", appliesTo: STARTERS,
        purpose: "Only a validated, admitted prerequisite wait (payer_dns readiness) moves the deadline.",
        order: { snapshotSeconds: 12 * h, recordedSeconds: null, purchaseReadiness: "payer_dns" }, resolvedAt: resolved,
        operations: { accumulatedWaitSeconds: 1_800, operations: operationsView(1, resolved + 12 * h, { fulfillment: {
          phase: "provisioning", reasons: [], pendingSince: null, lastCheckedAt: null, nextCheckAt: null, missingRecords: [],
          accumulatedWaitSeconds: 1_800 } }) },
        probes: [probe(resolved + 12 * h + 1_799, null, false, null), probe(resolved + 12 * h + 1_800, null, true, null)] },
      { id: "all-null-audit-earns-nothing", appliesTo: STARTERS,
        purpose: "An external audit observed with all-null operations accrues no wait exemption.",
        order: { snapshotSeconds: 12 * h, recordedSeconds: null, purchaseReadiness: null }, resolvedAt: resolved,
        operations: { accumulatedWaitSeconds: 0, operations: operationsView(0, resolved + 12 * h) },
        probes: [probe(resolved + 12 * h - 1, null, false, null), probe(resolved + 12 * h, null, true, null)] },
      { id: "reported-wait-without-admission-earns-nothing", appliesTo: STARTERS,
        purpose: "An ordinary audit must not be reported as a DNS wait; if it is, it still earns nothing without admitted payer_dns readiness.",
        order: { snapshotSeconds: 12 * h, recordedSeconds: null, purchaseReadiness: null }, resolvedAt: resolved,
        operations: { accumulatedWaitSeconds: 1_800, operations: operationsView(1, resolved + 12 * h, { fulfillment: {
          phase: "dns_pending", reasons: ["audit_running"], pendingSince: resolved, lastCheckedAt: resolved + 12 * h,
          nextCheckAt: resolved + 12 * h + 60, missingRecords: [], accumulatedWaitSeconds: 1_800 } }) },
        probes: [probe(resolved + 12 * h - 1, null, false, null), probe(resolved + 12 * h, null, true, null)] },
    ],
    initialDispatch: [
      { id: "delayed-first-dispatch", appliesTo: STARTERS,
        purpose: "A timely-paid order is dispatched afresh until its first release observation plus the snapshot's fulfillment duration, then stops.",
        firstReleaseObservedAt: AT.releaseObserved, snapshotSeconds: DEADLINE_POLICY.fulfillmentSeconds,
        probes: [{ at: AT.delayedDispatch, expect: "dispatched" }, { at: horizon - 1, expect: "dispatched" },
          { at: horizon, expect: "providerFailed" }] },
    ],
  };
}

async function negativesDocument(story: Story): Promise<Doc> {
  const quote = story.quotes["fixed-payer-lowercase"]!;
  const quoteEnvelope = quote.http.body.request as SignedEnvelope<Record<string, unknown>>;
  const initial = story.dispatches.initial!;
  const status = story.statuses.working!;
  const statusEnvelope = status.http.body.query as SignedEnvelope<Record<string, unknown>>;
  const life = story.lifecycles["status.read-capability.working"]!;
  const signedLife = story.lifecycles["cancel.payer-signed"]!;
  const providerNow = AT.midway;
  type Envelope = SignedEnvelope<Record<string, unknown>, number>;
  // The real signer over a deliberately altered envelope: every field but the defect stays valid.
  const resign = async (key: KeyName, envelope: SignedEnvelope<unknown, number>, patch: Doc): Promise<Envelope> => {
    const value = { ...envelope, ...patch } as Envelope;
    return await signEnvelope({
      artifactType: value.artifactType, schemaVersion: value.schemaVersion as 1, environment: value.environment,
      chainId: value.chainId, audience: value.audience, signerKeyId: value.signerKeyId, account: privateKeyToAccount(PRIVATE_KEYS[key]),
      issuedAt: value.issuedAt, validBefore: value.validBefore, payload: value.payload,
    }) as Envelope;
  };
  // Constructed requests: the bytes to send are JSON.stringify(body).
  const http = (url: string, body: Doc) => ({ method: "POST", url, headers: { ...OK }, body });
  const vectors: Doc[] = [];
  const add = (id: string, handler: string, purpose: string, body: Doc, check: Doc, now = providerNow) =>
    vectors.push({ id, handler, appliesTo: STARTERS, purpose, provider: { now }, check,
      http: http({ quote: CONTROL_PROFILE.quoteUrl, intake: CONTROL_PROFILE.quoteUrl, dispatch: CONTROL_PROFILE.dispatchUrl,
        status: CONTROL_PROFILE.dispatchStatusUrl, lifecycle: CONTROL_PROFILE.lifecycleUrl }[handler]!, body), expect: "reject" });
  const fresh = { issuedAt: providerNow - 5, validBefore: providerNow + 55 };
  const freshQuote = await resign("gatewayDispatch", quoteEnvelope, fresh);
  const field = (path: string, actual: unknown, expected: unknown) => ({ kind: "field", envelope: path.split(".")[0], path, actual, expected });
  const window = (envelope: string, problem: "expired" | "issued-in-future") => ({ kind: "window", envelope, problem });
  const binding = (left: string, right: string, compare: "equal" | "hash" = "equal") => ({ kind: "binding", left, right, compare });
  // Quote URL.
  add("quote.status-query-envelope", "quote", "Cross-type: a validly signed DispatchStatusQueryV1 is not a quote request.",
    { request: await resign("gatewayDispatch", statusEnvelope, fresh) },
    field("request.artifactType", "DispatchStatusQueryV1", ["ProviderQuoteRequestV1", "ProviderIntakeRequestV1"]));
  add("quote.dispatch-envelope", "quote", "Cross-type: a validly signed StandardRailDispatchV2 is not a quote request.",
    { request: initial.dispatch }, field("request.artifactType", "StandardRailDispatchV2", ["ProviderQuoteRequestV1", "ProviderIntakeRequestV1"]),
    AT.dispatch + 1);
  add("quote.lifecycle-grant", "quote", "Cross-type: a lifecycle grant, signed by another gateway key, is not a quote request.",
    { request: life.http.body.grant as Doc }, field("request.artifactType", "ProviderLifecycleGrantV1",
      ["ProviderQuoteRequestV1", "ProviderIntakeRequestV1"]), life.now);
  add("quote.wrong-audience", "quote", "A request for another provider's audience.",
    { request: await resign("gatewayDispatch", quoteEnvelope, { ...fresh, audience: "https://other-provider.example" }) },
    field("request.audience", "https://other-provider.example", PROVIDER_ORIGIN));
  add("quote.expired", "quote", "validBefore has passed.", { request: quoteEnvelope }, window("request", "expired"));
  add("quote.issued-in-future", "quote", "issuedAt more than 30 seconds ahead of the provider clock.",
    { request: await resign("gatewayDispatch", quoteEnvelope, { issuedAt: providerNow + 120, validBefore: providerNow + 180 }) },
    window("request", "issued-in-future"));
  add("quote.wrong-environment", "quote", "A mainnet envelope at a testnet provider.",
    { request: await resign("gatewayDispatch", quoteEnvelope, { ...fresh, environment: "mainnet" }) },
    field("request.environment", "mainnet", ENVIRONMENT));
  add("quote.wrong-chain", "quote", "An envelope for another chain.",
    { request: await resign("gatewayDispatch", quoteEnvelope, { ...fresh, chainId: 8_453 }) },
    field("request.chainId", 8_453, CHAIN_ID));
  add("quote.schema-version-2", "quote", "An unknown schema version.",
    { request: await resign("gatewayDispatch", quoteEnvelope, { ...fresh, schemaVersion: 2 }) },
    field("request.schemaVersion", 2, 1));
  add("quote.request-hash-mismatch", "quote", "Validly signed, but payload.requestHash does not hash payload.request.",
    { request: await resign("gatewayDispatch", quoteEnvelope, { ...fresh,
      payload: { ...quoteEnvelope.payload, request: { title: "Another title" } } }) },
    binding("request.payload.requestHash", "request.payload.request", "hash"));
  add("quote.signed-by-lifecycle-key", "quote", "Signed by gateway-lifecycle while naming gateway-dispatch.",
    { request: await resign("gatewayLifecycle", quoteEnvelope, fresh) }, { kind: "signer", envelope: "request", signedBy: "gatewayLifecycle" });
  add("quote.signed-by-unrecognized-key", "quote", "Signed by a key no gateway uses.",
    { request: await resign("unrecognized", quoteEnvelope, fresh) }, { kind: "signer", envelope: "request", signedBy: "unrecognized" });
  add("quote.tampered", "quote", "The payload changed after signing.",
    { request: { ...freshQuote, payload: { ...freshQuote.payload, payer: null } } }, { kind: "tampered", envelope: "request" });
  // Intake at the quote URL.
  const intakeEnvelope = story.intake.http.body.request as SignedEnvelope<Record<string, unknown>>;
  add("intake.wrong-audience", "intake", "An intake request for another provider's audience.",
    { request: await resign("gatewayDispatch", intakeEnvelope, { ...fresh, audience: "https://other-provider.example" }) },
    field("request.audience", "https://other-provider.example", PROVIDER_ORIGIN));
  add("intake.expired", "intake", "validBefore has passed.", { request: intakeEnvelope }, window("request", "expired"));
  // Dispatch URL.
  const dispatchBodyOf = (patch: Doc) => ({ ...initial.http.body, ...patch });
  const dispatchFresh = { issuedAt: providerNow - 5, validBefore: providerNow + 295 };
  const freshDispatch = await resign("gatewayDispatch", initial.dispatch, { ...dispatchFresh,
    payload: { ...initial.dispatch.payload, ...dispatchFresh } });
  add("dispatch.status-query-envelope", "dispatch", "Cross-type: a DispatchStatusQueryV1 in the dispatch field.",
    dispatchBodyOf({ dispatch: await resign("gatewayDispatch", statusEnvelope, fresh) }),
    field("dispatch.artifactType", "DispatchStatusQueryV1", "StandardRailDispatchV2"));
  add("dispatch.wrong-audience", "dispatch", "A dispatch for another provider's audience.",
    dispatchBodyOf({ dispatch: await resign("gatewayDispatch", freshDispatch, { audience: "https://other-provider.example" }) }),
    field("dispatch.audience", "https://other-provider.example", PROVIDER_ORIGIN));
  add("dispatch.expired", "dispatch", "A new dispatch whose validBefore has passed is never admitted.", dispatchBodyOf({}),
    window("dispatch", "expired"));
  add("dispatch.signed-by-unrecognized-key", "dispatch", "Signed by a key no gateway uses.",
    dispatchBodyOf({ dispatch: await resign("unrecognized", freshDispatch, {}) }),
    { kind: "signer", envelope: "dispatch", signedBy: "unrecognized" });
  add("dispatch.quote-signed-by-dispatch-key", "dispatch", "The forwarded QuoteV1 must be signed by gateway-quote.",
    dispatchBodyOf({ dispatch: freshDispatch, quote: await resign("gatewayDispatch", quote.quote, {}) }),
    { kind: "signer", envelope: "quote", signedBy: "gatewayDispatch" });
  add("dispatch.request-hash-mismatch", "dispatch", "The forwarded request does not hash to canonicalProviderRequestHash.",
    dispatchBodyOf({ dispatch: freshDispatch, request: { title: "Another title" } }),
    binding("dispatch.payload.canonicalProviderRequestHash", "request", "hash"));
  add("dispatch.tampered", "dispatch", "The payload changed after signing.",
    dispatchBodyOf({ dispatch: { ...freshDispatch, payload: { ...freshDispatch.payload, grossAmount: "1" } } }),
    { kind: "tampered", envelope: "dispatch" });
  // Dispatch status URL.
  add("status.quote-request-envelope", "status", "Cross-type: a quote request is not a status query; never answer it with outcome_policy.",
    { query: freshQuote }, field("query.artifactType", "ProviderQuoteRequestV1", "DispatchStatusQueryV1"));
  add("status.expired", "status", "An expired status query must not be answered, least of all with outcome_policy.",
    { query: statusEnvelope }, window("query", "expired"));
  add("status.wrong-audience", "status", "A status query for another provider's audience.",
    { query: await resign("gatewayDispatch", statusEnvelope, { ...fresh, audience: "https://other-provider.example",
      payload: { ...statusEnvelope.payload, ...fresh } }) },
    field("query.audience", "https://other-provider.example", PROVIDER_ORIGIN));
  add("status.signed-by-unrecognized-key", "status", "Signed by a key no gateway uses.",
    { query: await resign("unrecognized", statusEnvelope, { ...fresh, payload: { ...statusEnvelope.payload, ...fresh } }) },
    { kind: "signer", envelope: "query", signedBy: "unrecognized" });
  add("status.payload-window-mismatch", "status", "The payload's window must equal the envelope's.",
    { query: await resign("gatewayDispatch", statusEnvelope, fresh) },
    binding("query.payload.issuedAt", "query.issuedAt"));
  // Lifecycle URL.
  const grant = life.http.body.grant as SignedEnvelope<Record<string, unknown>>;
  const lifecycleFresh = { issuedAt: providerNow - 5, validBefore: providerNow + 115 };
  const lifeBody = (patch: Doc, grantPatch: Doc = {}, key: KeyName = "gatewayLifecycle") =>
    resign(key, grant, { ...lifecycleFresh, ...grantPatch }).then((signed) => ({ ...life.http.body, grant: signed, ...patch }));
  add("lifecycle.grant-signed-by-dispatch-key", "lifecycle", "Lifecycle grants are signed by gateway-lifecycle, not gateway-dispatch.",
    await lifeBody({}, {}, "gatewayDispatch"), { kind: "signer", envelope: "grant", signedBy: "gatewayDispatch" });
  add("lifecycle.grant-expired", "lifecycle", "The grant's validBefore has passed.", { ...life.http.body },
    window("grant", "expired"), AT.midway + 200);
  add("lifecycle.grant-wrong-audience", "lifecycle", "A grant for another provider's audience.",
    await lifeBody({}, { audience: "https://other-provider.example" }),
    field("grant.audience", "https://other-provider.example", PROVIDER_ORIGIN));
  const cancelStub = { type: "DaskiReadCap", scope: "cancel" };
  add("lifecycle.read-capability-for-cancel", "lifecycle", "A read capability never authorizes a mutation, even under a valid grant.",
    await lifeBody({ action: "cancel", authorization: cancelStub }, { payload: { ...grant.payload, action: "cancel",
      authorizationHash: canonicalHash(cancelStub) } }),
    { kind: "capability", rule: "authorization {type: DaskiReadCap} is accepted only for actions status and artifact" });
  const otherScope = { type: "DaskiReadCap", scope: "artifact" };
  add("lifecycle.read-capability-scope-mismatch", "lifecycle", "The read capability's scope must equal the action.",
    await lifeBody({ authorization: otherScope }, { payload: { ...grant.payload, authorizationHash: canonicalHash(otherScope) } }),
    binding("authorization.scope", "action"));
  add("lifecycle.cross-order-grant", "lifecycle", "A grant for another order presented with this order.",
    await lifeBody({}, { payload: { ...grant.payload, orderId: "ord_00000000-0000-4000-8000-000000000002" } }),
    binding("grant.payload.orderId", "orderId"));
  add("lifecycle.request-changed", "lifecycle", "The request changed after the grant bound its hash.",
    await lifeBody({ request: { verbose: true } }), binding("grant.payload.requestHash", "request", "hash"));
  add("lifecycle.payer-changed", "lifecycle", "The body names another payer than the grant.",
    await lifeBody({ payer: getAddress(ADDRESSES.unrecognized) }), binding("grant.payload.payer", "payer"));
  const authorization = signedLife.http.body.authorization as OrderActionChallenge & { signature: Hex };
  const signedGrant = signedLife.http.body.grant as SignedEnvelope<Record<string, unknown>>;
  const { signature: _payerSignature, ...issued } = authorization;
  const typed = (gatewayAudience: string) => {
    const request = orderActionSignRequest({ challenge: issued, chainId: CHAIN_ID, gatewayAudience });
    return { ...request, message: { ...request.message, issuedAt: BigInt(request.message.issuedAt),
      validBefore: BigInt(request.message.validBefore) } };
  };
  const forged = async (signature: Hex) => {
    const replaced = { ...authorization, signature };
    const regranted = await resign("gatewayLifecycle", signedGrant, { payload: { ...signedGrant.payload,
      authorizationHash: canonicalHash(replaced) } });
    return { ...signedLife.http.body, authorization: replaced, grant: regranted };
  };
  add("lifecycle.payer-signed-for-other-audience", "lifecycle",
    "The payer signed this action for another gateway audience; the grant is valid.",
    await forged(await privateKeyToAccount(PRIVATE_KEYS.payer).signTypedData(typed("https://other-gateway.example"))),
    { kind: "payer-signature", signedBy: "payer", audience: "https://other-gateway.example" }, signedLife.now);
  add("lifecycle.payer-signed-by-other-key", "lifecycle", "The authorization is signed by someone other than the order's payer.",
    await forged(await privateKeyToAccount(PRIVATE_KEYS.unrecognized).signTypedData(typed(GATEWAY_URL))),
    { kind: "payer-signature", signedBy: "unrecognized", audience: GATEWAY_URL }, signedLife.now);
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    rule: "Each request must be refused before any lookup, admission or mutation: a quote, intake, dispatch " +
      "or lifecycle handler answers a 4xx refusal (a dispatch pre-admission refusal is " +
      "{\"error\":\"dispatch_rejected\",\"reason\":...}); a status handler must never answer 404 with " +
      "reason outcome_policy. A handler checks artifactType and schemaVersion before it trusts any " +
      "signature, because one gateway key signs several envelope types.",
    bytes: "Send JSON.stringify(http.body) with http.headers to http.url.",
    checks: {
      field: "Every envelope is validly signed by the key its signerKeyId names; the value at path is actual, not expected.",
      window: "Every envelope is validly signed; at provider.now the envelope has expired (validBefore <= now) " +
        "or was issued more than 30 seconds ahead.",
      signer: "The envelope's signature recovers to signedBy, not to the key its signerKeyId names.",
      tampered: "The envelope changed after signing; its signature recovers to no configured key.",
      binding: "Every envelope is validly signed; the value at left differs from the value at right (compare " +
        "equal) or from canonicalHash of it (compare hash).",
      capability: "The grant is validly signed and binds this authorization, but a read capability never authorizes this action.",
      "payer-signature": "The grant is validly signed and binds this authorization; its EIP-712 signature recovers to " +
        "signedBy for audience, not to the order's payer for the gateway audience.",
    },
    vectors,
  };
}

/** Every fixture document, keyed by file name. */
export async function buildProviderWireFixtures(entropy: Entropy): Promise<Record<string, unknown>> {
  const story = await gatewayStory(entropy);
  return {
    "keys.json": keysDocument(),
    "context.json": contextDocument(story),
    "quote.json": await quoteDocument(story),
    "intake.json": await intakeDocument(story),
    "dispatch.json": await dispatchDocument(story),
    "dispatch-status.json": await statusDocument(story),
    "lifecycle.json": await lifecycleDocument(story),
    "terminal-evidence.json": await terminalDocument(story),
    "operations.json": operationsDocument(),
    "deadlines.json": deadlinesDocument(),
    "envelope-negatives.json": await negativesDocument(story),
  };
}
