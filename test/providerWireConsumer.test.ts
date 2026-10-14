import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAddress, recoverMessageAddress, recoverTypedDataAddress, type Hex } from "viem";

// Each dispatch envelope draws its nonce from randomBytes: replaying the
// committed nonce makes the gateway send the committed bytes again.
const entropy = vi.hoisted(() => ({ queue: [] as Buffer[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomBytes = (size: number) => {
    const planned = entropy.queue.shift();
    if (planned && planned.length !== size) throw new Error("Planned entropy has the wrong size");
    return planned ?? actual.randomBytes(size);
  };
  return { ...actual, randomBytes };
});

import { artifactPayloadHash, canonicalHash } from "../src/standardRail/canonical.js";
import { nextObservation, observeOperations, type StoredObservation, type TerminalEvidence } from "../src/standardRail/operationsStore.js";
import { orderActionSignRequest, type OrderAction, type OrderActionChallenge } from "../src/standardRail/orderAuthorization.js";
import type { QuoteV1, SignedEnvelope, StandardOrderRecord, StandardRailDispatchV2 } from "../src/standardRail/types.js";
import {
  ADDRESSES, CHAIN_ID, DEADLINE_POLICY, FIXTURE_SCHEMA_VERSION, PROVIDER_WIRE_DIR, SERVICE_RESULT_SCHEMA, TASK_ID,
  TASK_PROJECTION_SCHEMA, at, driveChallenge, driveDispatch, driveFulfillment, driveIntake, driveLifecycle, driveQuote,
  fixtureListing, fixtureOrder, httpResponse, operationsLedger, plan, raw, sha256,
  type KeyName, type ListingKind, type Outcome, type WireRequest, type WireResponse,
} from "./helpers/providerWire.js";

// The provider-wire fixtures as both starters vendor them, run through the
// gateway's own quote, intake, dispatch, dispatch-status, lifecycle,
// operations and deadline code. Every request a vector names is sent again by
// that code and must equal the committed bytes; every answer must meet its
// declared verdict exactly.

type Doc = Record<string, any>;
const load = (name: string): Doc => JSON.parse(readFileSync(path.join(PROVIDER_WIRE_DIR, name), "utf8")) as Doc;
const files = {
  manifest: load("manifest.json"), context: load("context.json"), quote: load("quote.json"), intake: load("intake.json"),
  dispatch: load("dispatch.json"), status: load("dispatch-status.json"), lifecycle: load("lifecycle.json"),
  terminal: load("terminal-evidence.json"), operations: load("operations.json"), deadlines: load("deadlines.json"),
  negatives: load("envelope-negatives.json"),
};
const issuedQuote = files.quote.requests["fixed-payer-lowercase"].issuedQuoteV1 as SignedEnvelope<QuoteV1>;
const initial = files.dispatch.requests.initial;
const get = (value: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value);

function sameRequest(sent: WireRequest, expected: Doc): void {
  expect(sent.url).toBe(expected.url);
  expect(sent.method).toBe(expected.method);
  expect(sent.headers).toEqual(expected.headers);
  expect(sent.bodyText).toBe(expected.bodyText);
}

function expectRejected(outcome: Outcome<unknown>, gateway: Doc): void {
  expect(outcome.ok, "the gateway accepted an answer it must refuse").toBe(false);
  const error = (outcome as { error: Error & Record<string, unknown> }).error;
  if (gateway.code) expect(error.code).toBe(gateway.code);
  if (gateway.message) expect(error.message).toBe(gateway.message);
  if (gateway.status) expect(error.status).toBe(gateway.status);
  if (gateway.requiresNewSignature !== undefined) expect(error.requiresNewSignature).toBe(gateway.requiresNewSignature);
  if (gateway.fieldErrors) expect(error.fieldErrors).toEqual(gateway.fieldErrors);
}

beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterAll(() => { vi.useRealTimers(); entropy.queue.length = 0; });

describe("the vendored provider-wire set", () => {
  it("verifies as a starter verifies it: every listed checksum, nothing unlisted", () => {
    expect(files.manifest.schemaVersion).toBe(FIXTURE_SCHEMA_VERSION);
    expect(readdirSync(PROVIDER_WIRE_DIR).sort()).toEqual(["manifest.json", ...Object.keys(files.manifest.files)].sort());
    for (const [name, entry] of Object.entries(files.manifest.files as Record<string, { sha256: string }>)) {
      expect(sha256(readFileSync(path.join(PROVIDER_WIRE_DIR, name))), name).toBe(entry.sha256);
    }
  });

  it("publishes keys that derive from their labels and the context's signers", () => {
    const keys = load("keys.json").keys as Record<string, { address: string }>;
    for (const [name, key] of Object.entries(keys)) expect(key.address).toBe(ADDRESSES[name as KeyName]);
    expect(files.context.gateway.signers).toEqual({ "gateway-dispatch": ADDRESSES.gatewayDispatch,
      "gateway-quote": ADDRESSES.gatewayQuote, "gateway-lifecycle": ADDRESSES.gatewayLifecycle });
    expect(initial.http.body.quote).toEqual(issuedQuote);
    expect(issuedQuote.payload.providerQuoteHash).toBe(files.context.order.providerQuoteHash);
    expect(initial.dispatchHash).toBe(canonicalHash(initial.http.body.dispatch));
  });

  it("forwards the QuoteV1 its challenge signed over the accepted provider quote", async () => {
    const request = files.quote.requests["fixed-payer-lowercase"];
    const answer = files.quote.responses.find((vector: Doc) => vector.id === "fixed.payer-lowercase.accepted");
    plan(entropy, issuedQuote.payload.orderNonce);
    at(request.gateway.now);
    const run = await driveChallenge({ listing: fixtureListing("fixed"), body: request.http.body.request.payload.request,
      payerAddress: ADDRESSES.payer, respond: (sent) => {
        sameRequest(sent, request.http);
        at(answer.gateway.receivedAt);
        return httpResponse(answer.response);
      } });
    expect(run.outcome.ok).toBe(true);
    expect(run.draft?.quote).toEqual(issuedQuote);
    expect(entropy.queue).toHaveLength(0);
  });
});

describe("quote answers", () => {
  for (const vector of files.quote.responses as Doc[]) {
    it(`${vector.id} is ${vector.gateway.verdict}`, async () => {
      const request = files.quote.requests[vector.request];
      const payload = request.http.body.request.payload;
      at(request.gateway.now);
      const run = await driveQuote({ listing: fixtureListing(request.listing as ListingKind), body: payload.request,
        payer: payload.payer, respond: (sent) => {
          sameRequest(sent, request.http);
          at(vector.gateway.receivedAt);
          return httpResponse(vector.response as WireResponse);
        } });
      if (vector.gateway.verdict === "accepted") {
        const { grossAmount, providerQuoteHash, issuedAt, validBefore } = vector.gateway;
        expect(run.outcome).toEqual({ ok: true, value: { grossAmount, providerQuoteHash, issuedAt, validBefore } });
      } else expectRejected(run.outcome, vector.gateway);
    });
  }
});

describe("intake answers", () => {
  for (const vector of files.intake.responses as Doc[]) {
    it(`${vector.id} is ${vector.gateway.verdict}`, async () => {
      const request = files.intake.requests[vector.request];
      at(request.gateway.now);
      const run = await driveIntake({ listing: fixtureListing("fixed"), request: request.http.body.request.payload.request,
        respond: (sent) => {
          sameRequest(sent, request.http);
          return httpResponse(vector.response as WireResponse);
        } });
      if (vector.gateway.verdict === "accepted") {
        const { signature: _signature, ...payload } = vector.response.body;
        expect(run.outcome).toEqual({ ok: true, value: { providerAgentId: files.context.provider.providerAgentId, ...payload } });
      } else expectRejected(run.outcome, vector.gateway);
    });
  }
});

function paidOrder(overrides: Partial<StandardOrderRecord> = {}): StandardOrderRecord {
  return fixtureOrder(issuedQuote, overrides);
}

describe("dispatch answers", () => {
  for (const vector of files.dispatch.responses as Doc[]) {
    it(`${vector.id} is ${vector.gateway.verdict}`, async () => {
      const request = files.dispatch.requests[vector.request];
      plan(entropy, request.http.body.dispatch.payload.dispatchNonce);
      at(request.gateway.now);
      const ledger = operationsLedger();
      const run = await driveDispatch({ order: paidOrder({ state: vector.gateway.orderState }), ledger, respond: (sent) => {
        sameRequest(sent, request.http);
        at(vector.gateway.receivedAt);
        return httpResponse(vector.response as WireResponse);
      } });
      expect(entropy.queue).toHaveLength(0);
      expect(run.error).toBeNull();
      expect(run.order.state).toBe(vector.gateway.orderStateAfter);
      if (vector.gateway.verdict === "accepted") {
        expect(run.resolved).toEqual({ taskId: vector.gateway.providerTaskId, dispatchHash: request.dispatchHash });
        expect(run.refusal).toBeNull();
        expect(ledger.stored?.observedAt).toBe(vector.response.body.operations.observedAt);
        expect(ledger.stored?.originalTerminal?.payload ?? null).toEqual(vector.response.body.terminalAttestation?.payload ?? null);
      } else {
        expect(run.resolved).toBeNull();
        expect(run.refusal).toEqual(vector.gateway.verdict === "refused" ? vector.gateway.refusal : null);
      }
    });
  }

  it.each(["retry-after-refusal", "delayed-first-dispatch"])("%s is sent byte for byte", async (name) => {
    const request = files.dispatch.requests[name];
    plan(entropy, request.http.body.dispatch.payload.dispatchNonce);
    at(request.gateway.now);
    const retry = name === "retry-after-refusal";
    const run = await driveDispatch({
      order: paidOrder({ state: retry ? "DISPATCH_STARTED" : "RELEASE_FINAL" }),
      ...(retry ? {
        persisted: { dispatch: initial.http.body.dispatch, request: initial.http.body.request },
        recovery: { startedAt: files.context.times.releaseObserved, retryPending: true, nextAttemptAt: request.gateway.now },
      } : {}),
      respond: (sent) => { sameRequest(sent, request.http); return httpResponse(raw(503, "")); },
    });
    expect(run.claimed && canonicalHash(run.claimed)).toBe(request.dispatchHash);
    expect(request.dispatchHash).not.toBe(initial.dispatchHash);
    expect(request.http.body.quote).toEqual(issuedQuote);
  });
});

describe("dispatch status answers", () => {
  for (const vector of files.status.responses as Doc[]) {
    it(`${vector.id} is ${vector.gateway.verdict}`, async () => {
      const request = files.status.requests[vector.request];
      at(request.gateway.now);
      const run = await driveDispatch({
        order: paidOrder({ state: vector.gateway.orderState }),
        persisted: { dispatch: initial.http.body.dispatch as SignedEnvelope<StandardRailDispatchV2, 2>,
          request: initial.http.body.request },
        respond: (sent) => { sameRequest(sent, request.http); return httpResponse(vector.response as WireResponse); },
      });
      expect(run.error).toBeNull();
      expect(run.claimed).toBeNull();
      if (vector.gateway.verdict === "accepted") {
        expect(run.resolved).toEqual({ taskId: TASK_ID, dispatchHash: initial.dispatchHash });
        expect(run.order.state).toBe(vector.gateway.orderStateAfter);
      } else {
        expect(run.resolved).toBeNull();
        expect(run.order.state).toBe("DISPATCH_AMBIGUOUS");
        expect(run.refusal).toEqual(vector.gateway.refusalRecorded ? vector.gateway.refusal : null);
      }
    });
  }
});

/** The observation the gateway already holds when a lifecycle vector runs. */
function stored(gateway: Doc): StoredObservation | null {
  if (!gateway.storedOperations) return null;
  const { observedAt: _observedAt, ...semantic } = gateway.storedOperations;
  return { revision: gateway.storedOperations.revision, observedAt: gateway.storedOperations.observedAt,
    projectionHash: canonicalHash(semantic), waitSeconds: 0, originalTerminal: gateway.storedTerminal as TerminalEvidence | null };
}

async function runLifecycle(vector: Doc) {
  const request = files.lifecycle.requests[vector.request];
  const schema = vector.gateway.resultSchema === "taskProjection" ? TASK_PROJECTION_SCHEMA : SERVICE_RESULT_SCHEMA;
  const order = paidOrder({ state: request.orderState, providerTaskId: TASK_ID, listing: fixtureListing("fixed", schema) });
  at(request.gateway.now);
  return driveLifecycle({
    order, action: request.action as OrderAction, request: request.http.body.request,
    access: request.access === "readCapability" ? { readCapability: true } : { authorization: request.http.body.authorization },
    ledger: operationsLedger(stored(vector.gateway)),
    respond: (sent) => {
      sameRequest(sent, request.http);
      expect(sent.headers).toEqual(files.lifecycle.headers);
      if (vector.gateway.receivedAt) at(vector.gateway.receivedAt);
      return httpResponse(vector.response as WireResponse);
    },
  });
}

describe("lifecycle answers", () => {
  for (const vector of [...files.lifecycle.responses, ...files.terminal.responses] as Doc[]) {
    it(`${vector.id} is ${vector.gateway.verdict}`, async () => {
      const run = await runLifecycle(vector);
      if (vector.gateway.verdict !== "accepted") return expectRejected(run.outcome, vector.gateway);
      expect(run.outcome.ok, String(!run.outcome.ok && run.outcome.error)).toBe(true);
      const delivered = (run.outcome as { value: Doc }).value;
      // The provider's signed answer reaches the buyer unchanged.
      for (const [key, value] of Object.entries(vector.response.body as Doc)) expect(delivered[key]).toEqual(value);
      expect(delivered.orderState).toBe(vector.gateway.orderStateAfter);
    });
  }

  for (const vector of files.lifecycle.refusals as Doc[]) {
    it(`${vector.id} is ${vector.gateway.verdict} as ${vector.gateway.code}`, async () => {
      expectRejected((await runLifecycle(vector)).outcome, vector.gateway);
    });
  }
});

describe("operations sequences", () => {
  for (const sequence of files.operations.sequences as Doc[]) {
    it(sequence.id, () => {
      let current: StoredObservation | null = null;
      for (const step of sequence.steps as Doc[]) {
        let next: StoredObservation | null = null;
        let error: unknown = null;
        try {
          next = nextObservation(current, observeOperations(step.operations, step.now), step.terminal);
        } catch (caught) { error = caught; }
        if (step.expect === "rejected") {
          expect((error as Error | null)?.message).toBe(step.error);
          continue;
        }
        expect(error).toBeNull();
        if (step.expect === "ignored") expect(next).toBeNull();
        else {
          expect(next).toMatchObject({ revision: step.operations.revision, observedAt: step.operations.observedAt });
          current = next;
        }
      }
    });
  }
});

describe("gateway deadlines", () => {
  for (const vector of files.deadlines.fulfillment as Doc[]) {
    it(vector.id, async () => {
      const state = { order: paidOrder({
        state: "DISPATCHED", providerTaskId: TASK_ID, effectiveFulfillmentSeconds: vector.order.recordedSeconds,
        listing: { ...fixtureListing("fixed"), purchaseReadiness: vector.order.purchaseReadiness,
          deadlinePolicy: { ...DEADLINE_POLICY, fulfillmentSeconds: vector.order.snapshotSeconds } },
      }) };
      for (const probe of vector.probes as Doc[]) {
        at(probe.at);
        const servicing = probe.servicing === "lookup-failed"
          ? async () => { throw new Error("servicing lookup unavailable"); }
          : async () => probe.servicing as number | null;
        const run = await driveFulfillment({ state, resolvedAt: vector.resolvedAt, operations: vector.operations, servicing });
        expect(run.providerFailed, `at ${probe.at}`).toBe(probe.expect.providerFailed);
        expect(state.order.effectiveFulfillmentSeconds ?? null).toBe(probe.expect.recordedSeconds);
      }
    });
  }

  for (const vector of files.deadlines.initialDispatch as Doc[]) {
    it(vector.id, async () => {
      for (const probe of vector.probes as Doc[]) {
        const delayed = files.dispatch.requests["delayed-first-dispatch"];
        if (probe.at === delayed.gateway.now) plan(entropy, delayed.http.body.dispatch.payload.dispatchNonce);
        at(probe.at);
        const run = await driveDispatch({ order: paidOrder(), recovery: { startedAt: vector.firstReleaseObservedAt },
          respond: () => httpResponse(raw(503, "")) });
        if (probe.expect === "providerFailed") {
          expect(run.request).toBeNull();
          expect(run.transitions).toEqual([{ state: "PROVIDER_FAILED", reason: "provider_dispatch_fulfillment_deadline_elapsed" }]);
          continue;
        }
        expect(run.claimed?.issuedAt).toBe(probe.at);
        expect(run.request?.body.quote).toEqual(issuedQuote);
        if (probe.at === delayed.gateway.now) expect(run.request?.bodyText).toBe(delayed.http.bodyText);
      }
    });
  }
});

const SIGNER_KEYS: Record<string, KeyName> = {
  "gateway-dispatch": "gatewayDispatch", "gateway-quote": "gatewayQuote", "gateway-lifecycle": "gatewayLifecycle",
};
async function signer(envelope: SignedEnvelope<unknown, number>): Promise<Hex> {
  return getAddress(await recoverMessageAddress({
    message: { raw: artifactPayloadHash(envelope as unknown as Record<string, unknown>) }, signature: envelope.signature,
  }));
}
/** Every gateway envelope in a request body (the buyer's own request is not one) recovers to its named key. */
async function validlySigned(body: Doc, except?: string): Promise<void> {
  const envelopes = Object.entries(body).filter(([name, value]) => name !== except &&
    value && typeof value === "object" && "artifactType" in value && "signature" in value);
  expect(envelopes.length + (except ? 1 : 0)).toBeGreaterThan(0);
  for (const [name, envelope] of envelopes) {
    expect(await signer(envelope as SignedEnvelope<unknown, number>), name).toBe(ADDRESSES[SIGNER_KEYS[envelope.signerKeyId]!]);
  }
}

describe("requests a provider must refuse", () => {
  for (const vector of files.negatives.vectors as Doc[]) {
    it(`${vector.id} is defective only as ${vector.check.kind}`, async () => {
      const body = vector.http.body as Doc;
      const check = vector.check as Doc;
      const now = vector.provider.now as number;
      expect(vector.expect).toBe("reject");
      if (check.kind === "signer" || check.kind === "tampered") {
        await validlySigned(body, check.envelope);
        const recovered = await signer(body[check.envelope]);
        expect(recovered).not.toBe(ADDRESSES[SIGNER_KEYS[body[check.envelope].signerKeyId]!]);
        if (check.kind === "signer") expect(recovered).toBe(ADDRESSES[check.signedBy as KeyName]);
        return;
      }
      await validlySigned(body);
      if (check.kind === "field") {
        expect(get(body, check.path)).toEqual(check.actual);
        expect(Array.isArray(check.expected) ? check.expected : [check.expected]).not.toContainEqual(check.actual);
      } else if (check.kind === "window") {
        const envelope = body[check.envelope];
        if (check.problem === "expired") expect(envelope.validBefore).toBeLessThanOrEqual(now);
        else expect(envelope.issuedAt).toBeGreaterThan(now + 30);
      } else if (check.kind === "binding") {
        const right = get(body, check.right);
        expect(get(body, check.left)).not.toEqual(check.compare === "hash" ? canonicalHash(right) : right);
      } else {
        expect(body.grant.payload.authorizationHash).toBe(canonicalHash(body.authorization));
        expect(body.grant.payload.action).toBe(body.action);
        if (check.kind === "capability") {
          expect(body.authorization.type).toBe("DaskiReadCap");
          expect(["status", "artifact"]).not.toContain(body.action);
        } else {
          const { signature, ...challenge } = body.authorization as OrderActionChallenge & { signature: Hex };
          const recover = async (gatewayAudience: string) => {
            const typed = orderActionSignRequest({ challenge, chainId: CHAIN_ID, gatewayAudience });
            return getAddress(await recoverTypedDataAddress({ ...typed, message: { ...typed.message,
              issuedAt: BigInt(typed.message.issuedAt), validBefore: BigInt(typed.message.validBefore) }, signature }));
          };
          expect(await recover(body.gatewayAudience)).not.toBe(getAddress(body.payer));
          expect(await recover(check.audience)).toBe(ADDRESSES[check.signedBy as KeyName]);
        }
      }
    });
  }
});
