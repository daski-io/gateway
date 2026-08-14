import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Hex } from "../types.js";
import { canonicalHash, canonicalJson } from "./canonical.js";

export interface CursorBinding {
  kind: string;
  environment: string;
  chainId: number;
  issuer: string;
  audience: string;
  payer: string;
  providerAgentId: string;
  queryHash: Hex;
}

export interface CursorOrderingTuple { createdAt: string; id: string }
export interface CursorKeyRing {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

interface CursorPlaintextV1 {
  kind: string;
  environment: string;
  payer: string;
  providerAgentId: string;
  queryHash: Hex;
  last: CursorOrderingTuple;
  issuedAt: number;
  validBefore: number;
}

function aad(binding: CursorBinding, keyId: string): Buffer {
  return Buffer.from(canonicalHash({
    version: "daski-cursor-a256gcm-v1",
    kind: binding.kind,
    environment: binding.environment,
    chainId: binding.chainId,
    issuer: binding.issuer,
    audience: binding.audience,
    keyId,
    payer: binding.payer.toLowerCase(),
    providerAgentId: binding.providerAgentId,
    queryHash: binding.queryHash,
  }).slice(2), "hex");
}

export function encryptCursor(args: {
  binding: CursorBinding;
  last: CursorOrderingTuple;
  keyRing: CursorKeyRing;
  now?: number;
}): string {
  const key = args.keyRing.keys.get(args.keyRing.activeKeyId);
  if (!key || key.length !== 32) throw new Error("invalid cursor");
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  const plaintext: CursorPlaintextV1 = {
    kind: args.binding.kind,
    environment: args.binding.environment,
    payer: args.binding.payer.toLowerCase(),
    providerAgentId: args.binding.providerAgentId,
    queryHash: args.binding.queryHash,
    last: args.last,
    issuedAt: now,
    validBefore: now + 900,
  };
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(args.binding, args.keyRing.activeKeyId));
  const ciphertext = Buffer.concat([cipher.update(canonicalJson(plaintext)), cipher.final()]);
  return `v1.${args.keyRing.activeKeyId}.${Buffer.concat([
    nonce, ciphertext, cipher.getAuthTag(),
  ]).toString("base64url")}`;
}

export function decryptCursor(args: {
  token: string;
  binding: CursorBinding;
  keyRing: CursorKeyRing;
  now?: number;
}): CursorOrderingTuple {
  const parts = args.token.split(".");
  const keyId = parts[1] ?? "";
  const key = args.keyRing.keys.get(keyId);
  const packed = Buffer.from(parts[2] ?? "", "base64url");
  if (parts.length !== 3 || parts[0] !== "v1" || !key || key.length !== 32 || packed.length < 29) {
    throw new Error("invalid cursor");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(aad(args.binding, keyId));
  decipher.setAuthTag(packed.subarray(-16));
  let cursor: CursorPlaintextV1;
  try {
    cursor = JSON.parse(Buffer.concat([
      decipher.update(packed.subarray(12, -16)), decipher.final(),
    ]).toString("utf8")) as CursorPlaintextV1;
  } catch { throw new Error("invalid cursor"); }
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  if (
    cursor.kind !== args.binding.kind || cursor.environment !== args.binding.environment ||
    cursor.payer !== args.binding.payer.toLowerCase() ||
    cursor.providerAgentId !== args.binding.providerAgentId ||
    cursor.queryHash !== args.binding.queryHash || cursor.issuedAt > now + 30 ||
    cursor.validBefore <= now || cursor.validBefore - cursor.issuedAt > 900 ||
    typeof cursor.last?.createdAt !== "string" || typeof cursor.last.id !== "string"
  ) throw new Error("invalid cursor");
  return cursor.last;
}
