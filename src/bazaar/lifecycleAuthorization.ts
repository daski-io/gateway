import {
  encodeAbiParameters,
  keccak256,
  parseSignature,
  recoverTypedDataAddress,
  toBytes,
  type Hex,
} from "viem";
import { canonicalJsonStringify } from "../auth/envelope.js";
import { isHex32, isHexAddress } from "../util/evmValidation.js";
import type {
  BazaarLifecycleAction,
} from "./types.js";

const HALF_SECP256K1_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const REQUEST_DOMAIN_HASH = keccak256(toBytes("DASKI_BAZAAR_LIFECYCLE_REQUEST_V1"));
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const MAX_UINT256 = (1n << 256n) - 1n;
const ACTIONS = new Set<BazaarLifecycleAction>([
  "ORDER_STATUS",
  "ARTIFACT_GET",
  "SUPPORT_MESSAGE",
]);

export const TASK_ACCESS_TYPES = {
  DaskiBazaarTaskAccess: [
    { name: "orderRecordId", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "providerAgentId", type: "uint256" },
    { name: "taskIdHash", type: "bytes32" },
    { name: "actionHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "challengeNonce", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export interface TaskAccessMessage extends Record<string, unknown> {
  orderRecordId: Hex;
  payer: Hex;
  providerAgentId: string;
  taskIdHash: Hex;
  actionHash: Hex;
  requestHash: Hex;
  challengeNonce: Hex;
  issuedAt: string;
  expiresAt: string;
}

export interface TaskAccessAuthorization {
  domain: ReturnType<typeof taskAccessDomain>;
  types: typeof TASK_ACCESS_TYPES;
  primaryType: "DaskiBazaarTaskAccess";
  message: TaskAccessMessage;
}

export interface ParsedChallengeClaim {
  chainId: bigint;
  payTo: Hex;
  payer: Hex;
  providerAgentId: bigint;
  taskIdHash: Hex;
  action: BazaarLifecycleAction;
  requestHash: Hex;
  request: Record<string, unknown>;
}

export function parseChallengeClaim(value: unknown): ParsedChallengeClaim | null {
  const body = asRecord(value);
  if (!body || !hasExactKeys(body, [
    "action", "chainId", "payTo", "payer", "providerAgentId", "requestHash",
    "request", "taskIdHash",
  ])) return null;
  if (
    !isCanonicalUint(body.chainId) ||
    !isCanonicalUint(body.providerAgentId) ||
    !isHexAddress(body.payTo) ||
    !isHexAddress(body.payer) ||
    !isHex32(body.taskIdHash) ||
    !isHex32(body.requestHash) ||
    typeof body.action !== "string" ||
    !ACTIONS.has(body.action as BazaarLifecycleAction)
  ) return null;
  const action = body.action as BazaarLifecycleAction;
  const request = parseLifecycleRequest(action, body.request);
  if (!request || body.requestHash.toLowerCase() !== lifecycleRequestHash(action, request)) {
    return null;
  }
  return {
    chainId: BigInt(body.chainId),
    providerAgentId: BigInt(body.providerAgentId),
    payTo: body.payTo.toLowerCase() as Hex,
    payer: body.payer.toLowerCase() as Hex,
    taskIdHash: body.taskIdHash.toLowerCase() as Hex,
    requestHash: body.requestHash.toLowerCase() as Hex,
    request,
    action,
  };
}

export function createTaskAccessAuthorization(input: {
  orderRecordId: Hex;
  claim: ParsedChallengeClaim;
  nonce: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
}): TaskAccessAuthorization {
  return {
    domain: taskAccessDomain(input.claim.chainId, input.claim.payTo),
    types: TASK_ACCESS_TYPES,
    primaryType: "DaskiBazaarTaskAccess",
    message: {
      orderRecordId: input.orderRecordId,
      payer: input.claim.payer,
      providerAgentId: input.claim.providerAgentId.toString(),
      taskIdHash: input.claim.taskIdHash,
      actionHash: actionHash(input.claim.action),
      requestHash: input.claim.requestHash,
      challengeNonce: input.nonce,
      issuedAt: input.issuedAt.toString(),
      expiresAt: input.expiresAt.toString(),
    },
  };
}

export async function verifyTaskAccessPayerSignature(input: {
  authorization: TaskAccessAuthorization;
  payerSignature: Hex;
}): Promise<boolean> {
  try {
    if (!canonicalSignature(input.payerSignature)) return false;
    const typed = toTypedData(input.authorization);
    const payer = await recoverTypedDataAddress({
      ...typed,
      signature: input.payerSignature,
    });
    return payer.toLowerCase() === input.authorization.message.payer.toLowerCase();
  } catch {
    return false;
  }
}

export function parseTaskAccessAuthorization(value: unknown): TaskAccessAuthorization | null {
  const authorization = asRecord(value);
  if (!authorization || !hasExactKeys(authorization, ["domain", "message", "primaryType", "types"])) {
    return null;
  }
  const message = asRecord(authorization.message);
  const domain = asRecord(authorization.domain);
  if (!message || !domain || authorization.primaryType !== "DaskiBazaarTaskAccess") return null;
  if (!validTaskAccessMessage(message) || !validDomain(domain)) return null;
  const canonical = {
    domain: taskAccessDomain(BigInt(domain.chainId as string), domain.verifyingContract as Hex),
    types: TASK_ACCESS_TYPES,
    primaryType: "DaskiBazaarTaskAccess" as const,
    message: message as unknown as TaskAccessMessage,
  };
  return canonicalJsonStringify(authorization) === canonicalJsonStringify(canonical)
    ? canonical
    : null;
}

export function actionFromHash(value: Hex): BazaarLifecycleAction | null {
  for (const action of ACTIONS) if (actionHash(action) === value.toLowerCase()) return action;
  return null;
}

export function lifecycleRequestHash(
  action: BazaarLifecycleAction,
  request: Record<string, unknown> = {},
): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [
      REQUEST_DOMAIN_HASH,
      actionHash(action),
      keccak256(toBytes(canonicalJsonStringify(request))),
    ],
  ));
}

export function parseLifecycleRequest(
  action: BazaarLifecycleAction,
  value: unknown,
): Record<string, unknown> | null {
  const request = asRecord(value);
  if (!request) return null;
  if (action !== "SUPPORT_MESSAGE") {
    return hasExactKeys(request, []) ? {} : null;
  }
  if (!hasExactKeys(request, ["message"]) || typeof request.message !== "string") {
    return null;
  }
  const message = request.message.replace(/\r\n?/g, "\n").normalize("NFC");
  if (
    message.length === 0 ||
    Array.from(message).length > 2_000 ||
    hasUnpairedSurrogate(message) ||
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u
      .test(message)
  ) return null;
  return { message };
}

export function taskAccessDomain(chainId: bigint, payTo: Hex) {
  return { name: "Daski Bazaar Task Access", version: "1", chainId: chainId.toString(), verifyingContract: payTo } as const;
}

export { ZERO_BYTES32 };

function actionHash(action: BazaarLifecycleAction): Hex {
  return keccak256(toBytes(action));
}

function validTaskAccessMessage(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, [
    "actionHash", "challengeNonce", "expiresAt", "issuedAt", "orderRecordId",
    "payer", "providerAgentId", "requestHash", "taskIdHash",
  ]) && isHex32(value.orderRecordId) && isHexAddress(value.payer) &&
    isCanonicalUint(value.providerAgentId) && isHex32(value.taskIdHash) &&
    isHex32(value.actionHash) && isHex32(value.requestHash) &&
    isHex32(value.challengeNonce) && isCanonicalUint(value.issuedAt) &&
    isCanonicalUint(value.expiresAt);
}

function validDomain(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ["chainId", "name", "verifyingContract", "version"]) &&
    value.name === "Daski Bazaar Task Access" && value.version === "1" &&
    isCanonicalUint(value.chainId) && isHexAddress(value.verifyingContract);
}

function canonicalSignature(value: Hex): boolean {
  if (!/^0x[0-9a-fA-F]{130}$/.test(value)) return false;
  return BigInt(parseSignature(value).s) <= HALF_SECP256K1_N;
}

function toTypedData(authorization: TaskAccessAuthorization) {
  const message = authorization.message;
  return {
    ...authorization,
    domain: {
      ...authorization.domain,
      chainId: BigInt(authorization.domain.chainId),
    },
    message: {
      orderRecordId: message.orderRecordId,
      payer: message.payer,
      providerAgentId: BigInt(message.providerAgentId),
      taskIdHash: message.taskIdHash,
      actionHash: message.actionHash,
      requestHash: message.requestHash,
      challengeNonce: message.challengeNonce,
      issuedAt: BigInt(message.issuedAt),
      expiresAt: BigInt(message.expiresAt),
    },
  };
}

function isCanonicalUint(value: unknown): value is string {
  return typeof value === "string" && value.length <= 78 &&
    /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= MAX_UINT256;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
