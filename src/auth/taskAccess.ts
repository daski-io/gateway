import { randomBytes } from "node:crypto";
import { recoverTypedDataAddress, type Hex } from "viem";
import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import { walletControlsAgent } from "../identity/control.js";
import { computeRequestHash } from "./envelope.js";
import { buildDaskiProviderDomain } from "./providerDomain.js";

const CAPABILITY_LIFETIME_SECONDS = 10 * 60;
const MAX_CAPABILITY_LIFETIME_SECONDS = 15 * 60;
const TASK_ID_MAX_LENGTH = 256;

export const TASK_ACCESS_AUTHORIZATION_TYPES = {
  TaskAccessAuthorization: [
    { name: "buyerTokenId", type: "uint256" },
    { name: "providerAgentId", type: "uint256" },
    { name: "taskId", type: "string" },
    { name: "action", type: "string" },
    { name: "requestHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

export const TASK_ACCESS_PRIMARY_TYPE = "TaskAccessAuthorization";
export const TASK_ACCESS_REQUEST_HASH = computeRequestHash({});

export interface TaskAccessAuthorization {
  buyerTokenId: string;
  providerAgentId: string;
  taskId: string;
  action: "get";
  requestHash: Hex;
  nonce: Hex;
  expiry: string;
}

export interface TaskAccessCapability {
  signature: Hex;
  authorization: TaskAccessAuthorization;
}

export function buildTaskAccessChallenge(
  config: Config,
  buyerTokenId: bigint,
  providerAgentId: bigint,
  taskId: string,
  now = Math.floor(Date.now() / 1000),
) {
  const authorization: TaskAccessAuthorization = {
    buyerTokenId: buyerTokenId.toString(),
    providerAgentId: providerAgentId.toString(),
    taskId,
    action: "get",
    requestHash: TASK_ACCESS_REQUEST_HASH,
    nonce: `0x${randomBytes(32).toString("hex")}`,
    expiry: (now + CAPABILITY_LIFETIME_SECONDS).toString(),
  };
  return {
    authorization,
    eip712TypedData: {
      domain: taskAccessDomain(config, providerAgentId),
      types: TASK_ACCESS_AUTHORIZATION_TYPES,
      primaryType: TASK_ACCESS_PRIMARY_TYPE,
      message: authorization,
    },
  };
}

export async function verifyTaskAccessCapability(
  config: Config,
  reader: ChainReader,
  capability: unknown,
  expected: { buyerTokenId: bigint; providerAgentId: bigint; taskId: string },
  now = Math.floor(Date.now() / 1000),
): Promise<{ ok: true } | { ok: false; code: string }> {
  const parsed = parseCapability(capability);
  if (!parsed) return { ok: false, code: "INVALID_SHAPE" };
  const { authorization } = parsed;
  if (
    authorization.buyerTokenId !== expected.buyerTokenId.toString() ||
    authorization.providerAgentId !== expected.providerAgentId.toString() ||
    authorization.taskId !== expected.taskId ||
    authorization.action !== "get" ||
    authorization.requestHash.toLowerCase() !==
      TASK_ACCESS_REQUEST_HASH.toLowerCase()
  ) {
    return { ok: false, code: "FIELD_MISMATCH" };
  }
  const expiry = BigInt(authorization.expiry);
  if (expiry <= BigInt(now)) return { ok: false, code: "EXPIRED" };
  if (expiry > BigInt(now + MAX_CAPABILITY_LIFETIME_SECONDS)) {
    return { ok: false, code: "EXPIRY_TOO_FAR" };
  }
  try {
    const signer = await recoverTypedDataAddress({
      domain: taskAccessDomain(config, expected.providerAgentId),
      types: TASK_ACCESS_AUTHORIZATION_TYPES,
      primaryType: TASK_ACCESS_PRIMARY_TYPE,
      message: {
        ...authorization,
        buyerTokenId: BigInt(authorization.buyerTokenId),
        providerAgentId: BigInt(authorization.providerAgentId),
        expiry,
      },
      signature: parsed.signature,
    });
    if (!(await walletControlsAgent(reader, expected.buyerTokenId, signer))) {
      return { ok: false, code: "WRONG_SIGNER" };
    }
  } catch {
    return { ok: false, code: "BAD_SIGNATURE" };
  }
  return { ok: true };
}

function taskAccessDomain(config: Config, providerAgentId: bigint) {
  return buildDaskiProviderDomain({
    chainId: config.chainId,
    identityRegistryAddress: config.identityRegistryAddress,
    providerAgentId,
  });
}

function parseCapability(value: unknown): TaskAccessCapability | null {
  if (!isRecord(value) || !hasExactKeys(value, ["signature", "authorization"])) {
    return null;
  }
  if (!isHex(value.signature, 65) || !isRecord(value.authorization)) return null;
  const authorization = value.authorization;
  if (
    !hasExactKeys(authorization, [
      "buyerTokenId",
      "providerAgentId",
      "taskId",
      "action",
      "requestHash",
      "nonce",
      "expiry",
    ]) ||
    !isDecimal(authorization.buyerTokenId) ||
    !isDecimal(authorization.providerAgentId) ||
    typeof authorization.taskId !== "string" ||
    authorization.taskId.length < 1 ||
    authorization.taskId.length > TASK_ID_MAX_LENGTH ||
    authorization.action !== "get" ||
    !isHex(authorization.requestHash, 32) ||
    !isHex(authorization.nonce, 32) ||
    !isDecimal(authorization.expiry)
  ) {
    return null;
  }
  return value as unknown as TaskAccessCapability;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key)
  );
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function isHex(value: unknown, bytes: number): value is Hex {
  return (
    typeof value === "string" &&
    new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)
  );
}
