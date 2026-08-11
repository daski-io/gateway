import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJsonStringify } from "../auth/envelope.js";
import type { TaskAccessAuthorization } from "./lifecycleAuthorization.js";
import type { BazaarChallengeMacKeyring } from "./types.js";

const MAC_CONTEXT = Buffer.from("DASKI_BAZAAR_TASK_CHALLENGE_V1\0", "utf8");
const EPOCH_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_RETAINED_KEY_LIFETIME_SECONDS = 10n * 60n + 30n;

export interface TaskAccessChallengePayloadV1 {
  version: "1";
  keyEpoch: string;
  authorization: TaskAccessAuthorization;
  request: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string;
}

export interface TaskAccessChallengeEnvelopeV1 {
  payload: TaskAccessChallengePayloadV1;
  tag: `0x${string}`;
}

export function validateChallengeMacKeyring(
  keyring: BazaarChallengeMacKeyring,
  nowSeconds: bigint,
): void {
  const keys = [keyring.current, ...(keyring.retained ?? [])];
  const epochs = new Set<string>();
  if (keys.length > 3) throw new Error("Bazaar challenge MAC retains too many keys");
  for (const key of keys) {
    if (!EPOCH_PATTERN.test(key.epoch) || key.secret.length !== 32) {
      throw new Error("Bazaar challenge MAC key is malformed");
    }
    if (epochs.has(key.epoch)) {
      throw new Error("Bazaar challenge MAC key epochs must be unique");
    }
    epochs.add(key.epoch);
  }
  for (const key of keyring.retained ?? []) {
    if (
      typeof key.acceptUntil !== "bigint" ||
      key.acceptUntil <= nowSeconds ||
      key.acceptUntil > nowSeconds + MAX_RETAINED_KEY_LIFETIME_SECONDS
    ) throw new Error("Bazaar retained challenge MAC lifetime is invalid");
  }
}

export function createTaskAccessChallengeEnvelope(input: {
  authorization: TaskAccessAuthorization;
  request: Record<string, unknown>;
  keyring: BazaarChallengeMacKeyring;
}): TaskAccessChallengeEnvelopeV1 {
  const payload: TaskAccessChallengePayloadV1 = {
    version: "1",
    keyEpoch: input.keyring.current.epoch,
    authorization: input.authorization,
    request: input.request,
    issuedAt: input.authorization.message.issuedAt,
    expiresAt: input.authorization.message.expiresAt,
  };
  return { payload, tag: computeTag(payload, input.keyring.current.secret) };
}

export function verifyTaskAccessChallengeEnvelope(
  value: unknown,
  keyring: BazaarChallengeMacKeyring,
  nowSeconds: bigint,
): TaskAccessChallengePayloadV1 | null {
  const envelope = asRecord(value);
  if (!envelope || !hasExactKeys(envelope, ["payload", "tag"])) return null;
  const payload = parsePayload(envelope.payload);
  if (!payload || !isTag(envelope.tag)) return null;
  const key = keyring.current.epoch === payload.keyEpoch
    ? keyring.current
    : (keyring.retained ?? []).find((candidate) =>
      candidate.epoch === payload.keyEpoch && candidate.acceptUntil >= nowSeconds);
  if (!key) return null;
  const expected = Buffer.from(computeTag(payload, key.secret).slice(2), "hex");
  const actual = Buffer.from(envelope.tag.slice(2), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? payload
    : null;
}

function parsePayload(value: unknown): TaskAccessChallengePayloadV1 | null {
  const payload = asRecord(value);
  if (!payload || !hasExactKeys(payload, [
    "authorization", "expiresAt", "issuedAt", "keyEpoch", "request", "version",
  ])) return null;
  if (
    payload.version !== "1" ||
    typeof payload.keyEpoch !== "string" ||
    !EPOCH_PATTERN.test(payload.keyEpoch) ||
    typeof payload.issuedAt !== "string" ||
    typeof payload.expiresAt !== "string"
  ) return null;
  if (!asRecord(payload.request)) return null;
  const authorization = payload.authorization as TaskAccessAuthorization;
  if (
    payload.issuedAt !== authorization?.message?.issuedAt ||
    payload.expiresAt !== authorization?.message?.expiresAt
  ) return null;
  return payload as unknown as TaskAccessChallengePayloadV1;
}

function computeTag(
  payload: TaskAccessChallengePayloadV1,
  secret: Buffer,
): `0x${string}` {
  const hmac = createHmac("sha256", secret);
  hmac.update(MAC_CONTEXT);
  hmac.update(Buffer.from(canonicalJsonStringify(payload), "utf8"));
  return `0x${hmac.digest("hex")}`;
}

function isTag(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
