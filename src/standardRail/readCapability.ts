import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { getAddress, type Hex } from "viem";
import { StandardRailError, standardRailError } from "./errors.js";

const READ_CAPABILITY_VERSION = 1;
const READ_SCOPES = ["status", "artifact"] as const;
export type ReadCapabilityScope = typeof READ_SCOPES[number];

interface ReadCapabilityPayload {
  v: 1;
  orderId: string;
  payer: Hex;
  audience: string;
  scope: ReadCapabilityScope[];
  exp: number;
  jti: string;
  epoch: number;
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac("sha256", key)
    .update("daski-read-capability-v1\0")
    .update(body)
    .digest();
}

function invalid(cause?: unknown): never {
  throw standardRailError("WALLET_AUTHORIZATION_INVALID", {
    message: "Read capability is invalid or expired",
    nextAction: "Re-run daski_get_order_access and sign the new grant-read challenge.",
    internalMessage: "Daski read capability verification failed",
    cause,
  });
}

export function issueReadCapability(args: {
  key: Buffer;
  orderId: string;
  payer: Hex;
  audience: string;
  capabilityEpoch: number;
  ttlSeconds: number;
  nowSeconds?: number;
}): { readCapability: string; expiresAt: number; scope: ReadCapabilityScope[] } {
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const payload: ReadCapabilityPayload = {
    v: READ_CAPABILITY_VERSION,
    orderId: args.orderId,
    payer: getAddress(args.payer).toLowerCase() as Hex,
    audience: args.audience,
    scope: [...READ_SCOPES],
    exp: now + args.ttlSeconds,
    jti: randomUUID(),
    epoch: args.capabilityEpoch,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = mac(args.key, body).toString("base64url");
  return {
    readCapability: body + "." + signature,
    expiresAt: payload.exp,
    scope: payload.scope,
  };
}

export function verifyReadCapability(args: {
  key: Buffer;
  token: string;
  orderId: string;
  payer: Hex;
  audience: string;
  capabilityEpoch: number;
  requiredScope: ReadCapabilityScope;
  nowSeconds?: number;
}): ReadCapabilityPayload {
  try {
    if (args.token.length < 80 || args.token.length > 2_048) invalid();
    const parts = args.token.split(".");
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) invalid();
    const [body, signatureText] = parts as [string, string];
    const signature = Buffer.from(signatureText, "base64url");
    const expectedSignature = mac(args.key, body);
    if (signature.length !== expectedSignature.length ||
        !timingSafeEqual(signature, expectedSignature)) invalid();
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as
      Partial<ReadCapabilityPayload>;
    const keys = Object.keys(payload).sort().join(",");
    if (keys !== "audience,epoch,exp,jti,orderId,payer,scope,v") invalid();
    const now = args.nowSeconds ?? Math.floor(Date.now() / 1_000);
    if (
      payload.v !== READ_CAPABILITY_VERSION ||
      payload.orderId !== args.orderId ||
      typeof payload.payer !== "string" ||
      getAddress(payload.payer) !== getAddress(args.payer) ||
      payload.audience !== args.audience ||
      !Array.isArray(payload.scope) ||
      payload.scope.some((scope) => !READ_SCOPES.includes(scope as ReadCapabilityScope)) ||
      !payload.scope.includes(args.requiredScope) ||
      !Number.isSafeInteger(payload.exp) ||
      Number(payload.exp) <= now ||
      !Number.isSafeInteger(payload.epoch) ||
      payload.epoch !== args.capabilityEpoch ||
      typeof payload.jti !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(payload.jti)
    ) invalid();
    return payload as ReadCapabilityPayload;
  } catch (error) {
    if (error instanceof StandardRailError) throw error;
    invalid(error);
  }
}
