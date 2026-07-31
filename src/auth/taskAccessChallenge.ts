import type { Config } from "../config.js";
import type { Hex } from "../types.js";
import {
  TASK_ACCESS_AUTHORIZATION_TYPES,
  TASK_ACCESS_PRIMARY_TYPE,
} from "./taskAccess.js";
import {
  DASKI_PROVIDER_DOMAIN_NAME,
  DASKI_PROVIDER_DOMAIN_VERSION,
  providerAgentIdDomainSalt,
} from "./providerDomain.js";

const MAX_CAPABILITY_LIFETIME_SECONDS = 15 * 60;
const TASK_ID_MAX_LENGTH = 256;
const VALID_ACTIONS = new Set([
  "get",
  "cancel",
  "input",
  "push-set",
  "push-get",
  "document-download",
]);
const AUTHORIZATION_KEYS = [
  "buyerTokenId",
  "providerAgentId",
  "taskId",
  "action",
  "requestHash",
  "nonce",
  "expiry",
] as const;

export interface ProviderTaskAccessChallenge {
  authorization: Record<string, unknown>;
  eip712TypedData: Record<string, unknown>;
}

interface ExpectedChallenge {
  buyerTokenId?: bigint;
  providerAgentId: bigint;
  taskId?: string;
  action?: string;
}

export function validateProviderTaskAccessChallenge(
  config: Config,
  value: unknown,
  expected: ExpectedChallenge,
  now = Math.floor(Date.now() / 1000),
): ProviderTaskAccessChallenge | null {
  const challenge = asRecord(value);
  const authorization = asRecord(challenge?.authorization);
  const typedData = asRecord(challenge?.eip712TypedData);
  const domain = asRecord(typedData?.domain);
  const message = asRecord(typedData?.message);
  if (!authorization || !typedData || !domain || !message) return null;

  if (!validAuthorization(authorization, expected, now)) return null;
  if (!sameAuthorization(authorization, message)) return null;
  if (
    !hasExactKeys(domain, [
      "name",
      "version",
      "chainId",
      "verifyingContract",
      "salt",
    ]) ||
    domain.name !== DASKI_PROVIDER_DOMAIN_NAME ||
    domain.version !== DASKI_PROVIDER_DOMAIN_VERSION ||
    domain.chainId !== config.chainId ||
    !sameAddress(domain.verifyingContract, config.identityRegistryAddress) ||
    !sameHex32(
      domain.salt,
      providerAgentIdDomainSalt(expected.providerAgentId),
    ) ||
    typedData.primaryType !== TASK_ACCESS_PRIMARY_TYPE ||
    !sameTypes(typedData.types)
  ) {
    return null;
  }
  return { authorization, eip712TypedData: typedData };
}

function validAuthorization(
  authorization: Record<string, unknown>,
  expected: ExpectedChallenge,
  now: number,
): boolean {
  const keys = Object.keys(authorization);
  if (
    !keys.every(
      (key) =>
        (AUTHORIZATION_KEYS as readonly string[]).includes(key) ||
        key === "resource",
    ) ||
    !AUTHORIZATION_KEYS.every((key) => keys.includes(key)) ||
    !isDecimal(authorization.buyerTokenId) ||
    authorization.providerAgentId !== expected.providerAgentId.toString() ||
    typeof authorization.taskId !== "string" ||
    authorization.taskId.length < 1 ||
    authorization.taskId.length > TASK_ID_MAX_LENGTH ||
    !VALID_ACTIONS.has(String(authorization.action)) ||
    !isHex32(authorization.requestHash) ||
    !isHex32(authorization.nonce) ||
    !isDecimal(authorization.expiry)
  ) {
    return false;
  }
  if (expected.taskId !== undefined && authorization.taskId !== expected.taskId) {
    return false;
  }
  if (
    expected.buyerTokenId !== undefined &&
    authorization.buyerTokenId !== expected.buyerTokenId.toString()
  ) {
    return false;
  }
  if (expected.action !== undefined && authorization.action !== expected.action) {
    return false;
  }
  if (
    authorization.resource !== undefined &&
    typeof authorization.resource !== "string"
  ) {
    return false;
  }
  const expiry = BigInt(authorization.expiry);
  return (
    expiry > BigInt(now) &&
    expiry <= BigInt(now + MAX_CAPABILITY_LIFETIME_SECONDS)
  );
}

function sameAuthorization(
  authorization: Record<string, unknown>,
  message: Record<string, unknown>,
): boolean {
  const authorizationKeys = Object.keys(authorization).sort();
  const messageKeys = Object.keys(message).sort();
  return (
    authorizationKeys.length === messageKeys.length &&
    authorizationKeys.every(
      (key, index) =>
        key === messageKeys[index] && authorization[key] === message[key],
    )
  );
}

function sameTypes(value: unknown): boolean {
  const types = asRecord(value);
  if (!types || Object.keys(types).length !== 1) return false;
  return (
    JSON.stringify(types.TaskAccessAuthorization) ===
    JSON.stringify(TASK_ACCESS_AUTHORIZATION_TYPES.TaskAccessAuthorization)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => key === actual[index])
  );
}

function sameAddress(value: unknown, expected: Hex): boolean {
  return (
    typeof value === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(value) &&
    value.toLowerCase() === expected.toLowerCase()
  );
}

function sameHex32(value: unknown, expected: Hex): boolean {
  return isHex32(value) && value.toLowerCase() === expected.toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}
