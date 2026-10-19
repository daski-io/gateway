import { logger } from "../util/logger.js";
import type { RpcFailure } from "./classification.js";

/**
 * Per-endpoint circuit breakers shared by every RPC client of the process.
 *
 * An endpoint opens after three consecutive failures, or when more than 20%
 * of at least ten observations in the last minute failed. While open it is
 * skipped for a cooldown that starts at one minute and doubles, up to ten
 * minutes, each time the probe after a cooldown fails. One observation at a
 * time probes it (half-open) and a success closes it. Only endpoint faults
 * count: a chain answer, a local pacing refusal or an observation's own
 * assertion never does. An endpoint that asked for a pause (Retry-After) is
 * deferred until then. A deferred endpoint is still tried after every
 * available one failed, least recently opened first, so no observation fails
 * without trying every endpoint.
 *
 * The state is bounded: at most MAX_TRACKED_ENDPOINTS endpoints (least
 * recently used evicted) with a fixed sixty-bucket window each.
 */
export const RPC_BREAKER = Object.freeze({
  consecutiveFailures: 3,
  windowMs: 60_000,
  minimumSamples: 10,
  failureRate: 0.2,
  cooldownMs: 60_000,
  maxCooldownMs: 600_000,
  /** A probe running longer than this no longer keeps other observations from probing. */
  probeLeaseMs: 60_000,
});

const MAX_TRACKED_ENDPOINTS = 32;
const WINDOW_BUCKETS = 60;
const BUCKET_MS = RPC_BREAKER.windowMs / WINDOW_BUCKETS;

export type RpcBreakerState = "closed" | "open" | "half-open";

interface Bucket { slot: number; ok: number; failed: number }

interface EndpointHealth {
  host: string;
  state: RpcBreakerState;
  consecutive: number;
  buckets: Bucket[];
  openedAt: number;
  openUntil: number;
  cooldownMs: number;
  /** The observation holding the probe (reserved while open, running while half-open). */
  probeOwner: object | null;
  probeSince: number;
  /** Retry-After: not asked again before this time unless nothing else is left. */
  notBefore: number;
  notBeforeSetAt: number;
}

const endpoints = new Map<string, EndpointHealth>();

/** The registry key: the endpoint URL when known (never logged), else its host. */
export function rpcEndpointKey(endpoint: { host: string; url?: string }): string {
  return endpoint.url ?? endpoint.host;
}

function entryFor(endpoint: { host: string; url?: string }): EndpointHealth {
  const key = rpcEndpointKey(endpoint);
  let entry = endpoints.get(key);
  if (entry) {
    endpoints.delete(key);
  } else {
    entry = {
      host: endpoint.host, state: "closed", consecutive: 0,
      buckets: Array.from({ length: WINDOW_BUCKETS }, () => ({ slot: -1, ok: 0, failed: 0 })),
      openedAt: 0, openUntil: 0, cooldownMs: RPC_BREAKER.cooldownMs,
      probeOwner: null, probeSince: 0, notBefore: 0, notBeforeSetAt: 0,
    };
    while (endpoints.size >= MAX_TRACKED_ENDPOINTS) endpoints.delete(endpoints.keys().next().value!);
  }
  endpoints.set(key, entry);
  return entry;
}

function sample(entry: EndpointHealth, failed: boolean, now: number): void {
  const slot = Math.floor(now / BUCKET_MS);
  const bucket = entry.buckets[slot % WINDOW_BUCKETS]!;
  if (bucket.slot !== slot) Object.assign(bucket, { slot, ok: 0, failed: 0 });
  if (failed) bucket.failed += 1; else bucket.ok += 1;
}

function windowCounts(entry: EndpointHealth, now: number): { samples: number; failures: number } {
  const oldest = Math.floor(now / BUCKET_MS) - WINDOW_BUCKETS + 1;
  let samples = 0, failures = 0;
  for (const bucket of entry.buckets) {
    if (bucket.slot < oldest) continue;
    samples += bucket.ok + bucket.failed;
    failures += bucket.failed;
  }
  return { samples, failures };
}

function clearWindow(entry: EndpointHealth): void {
  for (const bucket of entry.buckets) Object.assign(bucket, { slot: -1, ok: 0, failed: 0 });
}

function transition(entry: EndpointHealth, to: RpcBreakerState, now: number, reason?: string): void {
  const from = entry.state;
  if (from === to) return;
  entry.state = to;
  const counts = windowCounts(entry, now);
  const detail = {
    host: entry.host,
    from,
    to,
    failures: entry.consecutive,
    windowFailures: counts.failures,
    windowSamples: counts.samples,
    cooldownMs: entry.cooldownMs,
    ...(reason ? { reason } : {}),
  };
  if (to === "open") logger.warn("RPC endpoint circuit opened", detail);
  else if (to === "half-open") logger.info("RPC endpoint circuit half-open", detail);
  else logger.info("RPC endpoint circuit closed", detail);
}

function open(entry: EndpointHealth, now: number, reason: string): void {
  if (entry.state === "half-open") {
    entry.cooldownMs = Math.min(RPC_BREAKER.maxCooldownMs, entry.cooldownMs * 2);
  }
  entry.openedAt = now;
  entry.openUntil = now + entry.cooldownMs;
  entry.probeOwner = null;
  transition(entry, "open", now, reason);
}

function probeHeld(entry: EndpointHealth, owner: object, now: number): boolean {
  return entry.probeOwner !== null && entry.probeOwner !== owner &&
    now - entry.probeSince < RPC_BREAKER.probeLeaseMs;
}

export type RpcDeferral = "open" | "probing" | "retry_after";

export interface PlannedRpcEndpoint<Endpoint> {
  endpoint: Endpoint;
  /** Position in the configured order: 0 is the primary. */
  index: number;
  /** Why the breaker put this endpoint behind the available ones, if it did. */
  deferral?: RpcDeferral;
}

/**
 * The order one observation (`owner`) tries endpoints in: the available ones
 * in configured order, then the deferred ones, least recently opened first.
 * An open endpoint whose cooldown has elapsed is available to the first
 * observation that plans it, which reserves its probe; the others defer it
 * until that probe settles. Call releaseRpcPlan(owner) when the observation
 * ends, so an unused reservation returns.
 */
export function planRpcEndpoints<Endpoint extends { host: string; url?: string }>(
  configured: readonly Endpoint[],
  owner: object,
  now = Date.now(),
): PlannedRpcEndpoint<Endpoint>[] {
  const available: PlannedRpcEndpoint<Endpoint>[] = [];
  const deferred: Array<PlannedRpcEndpoint<Endpoint> & { since: number }> = [];
  configured.forEach((endpoint, index) => {
    const entry = endpoints.get(rpcEndpointKey(endpoint));
    if (!entry || (entry.state === "closed" && now >= entry.notBefore)) {
      available.push({ endpoint, index });
    } else if (entry.state === "closed") {
      deferred.push({ endpoint, index, deferral: "retry_after", since: entry.notBeforeSetAt });
    } else if (probeHeld(entry, owner, now)) {
      deferred.push({ endpoint, index, deferral: "probing", since: entry.openedAt });
    } else if ((entry.state === "open" && now >= entry.openUntil) || entry.state === "half-open") {
      // The cooldown elapsed, or the probe in flight outlived its lease.
      entry.probeOwner = owner;
      entry.probeSince = now;
      available.push({ endpoint, index });
    } else {
      deferred.push({ endpoint, index, deferral: "open", since: entry.openedAt });
    }
  });
  deferred.sort((left, right) => left.since - right.since || left.index - right.index);
  return [...available, ...deferred.map(({ since: _since, ...planned }) => planned)];
}

/** Returns every probe reservation `owner` did not use. */
export function releaseRpcPlan(owner: object): void {
  for (const entry of endpoints.values()) {
    if (entry.probeOwner === owner && entry.state === "open") entry.probeOwner = null;
  }
}

/** One observation attempt against one endpoint. */
export interface RpcAttempt {
  /** The attempt is the half-open probe of an open endpoint. */
  readonly probe: boolean;
  succeeded(): void;
  failed(failure: RpcFailure): void;
  /** The attempt ended without evidence about the endpoint's health. */
  inconclusive(): void;
}

export function beginRpcAttempt(
  endpoint: { host: string; url?: string },
  owner: object,
  now = Date.now(),
): RpcAttempt {
  const entry = entryFor(endpoint);
  const probe = entry.state === "open" && entry.probeOwner === owner;
  if (probe) {
    entry.probeSince = now;
    transition(entry, "half-open", now);
  }
  let settled = false;
  const settle = () => !settled && (settled = true);
  const endProbe = () => { if (probe && entry.probeOwner === owner) entry.probeOwner = null; };
  return {
    probe,
    succeeded() {
      if (!settle()) return;
      const at = Date.now();
      endProbe();
      entry.consecutive = 0;
      entry.notBefore = 0;
      if (entry.state !== "closed") {
        entry.cooldownMs = RPC_BREAKER.cooldownMs;
        entry.probeOwner = null;
        clearWindow(entry);
        transition(entry, "closed", at);
      }
      sample(entry, false, at);
    },
    failed(failure) {
      if (!settle()) return;
      const at = Date.now();
      endProbe();
      if (failure.retryAfterMs !== undefined && failure.retryAfterMs > 0) {
        entry.notBefore = Math.max(entry.notBefore, at + failure.retryAfterMs);
        entry.notBeforeSetAt = at;
      }
      entry.consecutive += 1;
      sample(entry, true, at);
      if (entry.state === "half-open") {
        open(entry, at, failure.reason);
        return;
      }
      if (entry.state !== "closed") return;
      const counts = windowCounts(entry, at);
      if (entry.consecutive >= RPC_BREAKER.consecutiveFailures ||
          (counts.samples >= RPC_BREAKER.minimumSamples &&
            counts.failures / counts.samples > RPC_BREAKER.failureRate)) {
        open(entry, at, failure.reason);
      }
    },
    inconclusive() {
      if (!settle()) return;
      endProbe();
      if (probe && entry.state === "half-open") {
        // The probe proved nothing: the circuit stays open with its elapsed
        // cooldown, so the next observation probes again.
        entry.state = "open";
        logger.info("RPC endpoint circuit probe inconclusive", { host: entry.host, from: "half-open", to: "open" });
      }
    },
  };
}

/** Whether the endpoint's breaker is open (or probing) right now. */
export function isRpcEndpointOpen(endpoint: { host: string; url?: string }): boolean {
  const entry = endpoints.get(rpcEndpointKey(endpoint));
  return entry !== undefined && entry.state !== "closed";
}

export interface RpcEndpointHealthSnapshot {
  host: string;
  state: RpcBreakerState;
  consecutiveFailures: number;
  cooldownMs: number;
  openUntil: number | null;
  windowSamples: number;
  windowFailures: number;
}

/** A diagnostic view of every tracked endpoint (hosts only). */
export function rpcEndpointHealthSnapshot(now = Date.now()): RpcEndpointHealthSnapshot[] {
  return [...endpoints.values()].map((entry) => {
    const counts = windowCounts(entry, now);
    return {
      host: entry.host,
      state: entry.state,
      consecutiveFailures: entry.consecutive,
      cooldownMs: entry.cooldownMs,
      openUntil: entry.state === "closed" ? null : entry.openUntil,
      windowSamples: counts.samples,
      windowFailures: counts.failures,
    };
  });
}

/** Forgets every endpoint's health (tests, and a deliberate operator reset). */
export function resetRpcEndpointHealth(): void {
  endpoints.clear();
}
