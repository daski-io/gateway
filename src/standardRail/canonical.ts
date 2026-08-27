import { encodeAbiParameters, keccak256, stringToHex, type Address } from "viem";
import type { Hex } from "../types.js";
import type { ProviderIdentitySnapshotV1 } from "./types.js";

// Backstop for values that never pass request validation: canonicalization
// is recursive, so depth is capped, and hashed objects must not carry keys
// that alias Object.prototype members.
const CANONICAL_MAX_DEPTH = 64;
const UNSAFE_CANONICAL_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("Canonical JSON contains invalid Unicode");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Canonical JSON contains invalid Unicode");
    }
  }
}

function canonicalValue(value: unknown, depth: number): string {
  if (depth > CANONICAL_MAX_DEPTH) throw new Error("Canonical JSON is too deeply nested");
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON accepts only finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item, depth + 1)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("Canonical JSON contains an unsupported value");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${keys.map((key) => {
    assertValidUnicode(key);
    if (UNSAFE_CANONICAL_KEYS.has(key)) throw new Error("Canonical JSON contains an unsafe key");
    const child = object[key];
    if (child === undefined) throw new Error("Canonical JSON contains undefined");
    return `${JSON.stringify(key)}:${canonicalValue(child, depth + 1)}`;
  }).join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value, 1);
}

// Belt limits for every JSON document this scanner admits, applied at the
// parse boundary before any handler sees the value. Semantic budgets in
// jsonBounds.ts are stricter; these only stop pathological documents.
const SCANNER_MAX_DEPTH = 64;
const SCANNER_MAX_NODES = 262_144;
const SCANNER_MAX_KEY_LENGTH = 256;

export function assertNoDuplicateJsonKeys(text: string): void {
  let offset = 0;
  let nodes = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? "")) offset += 1; };
  const stringToken = (): string => {
    const start = offset;
    if (text[offset] !== '"') throw new Error("JSON string expected");
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset)) as string;
      }
      offset += 1;
    }
    throw new Error("Unterminated JSON string");
  };
  const value = (depth: number): void => {
    nodes += 1;
    if (depth > SCANNER_MAX_DEPTH) throw new Error("JSON is too deeply nested");
    if (nodes > SCANNER_MAX_NODES) throw new Error("JSON contains too many values");
    whitespace();
    if (text[offset] === '"') { stringToken(); return; }
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") { offset += 1; return; }
      while (true) {
        whitespace();
        const key = stringToken();
        if (key.length > SCANNER_MAX_KEY_LENGTH) throw new Error("JSON key is too long");
        if (UNSAFE_CANONICAL_KEYS.has(key)) throw new Error("JSON contains an unsafe key");
        if (keys.has(key)) throw new Error(`Duplicate JSON key ${key}`);
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") throw new Error("JSON colon expected");
        offset += 1;
        value(depth + 1);
        whitespace();
        if (text[offset] === "}") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("JSON comma expected");
        offset += 1;
      }
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      while (true) {
        value(depth + 1);
        whitespace();
        if (text[offset] === "]") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("JSON comma expected");
        offset += 1;
      }
    }
    const token = text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new Error("Invalid JSON token");
    offset += token.length;
  };
  value(1);
  whitespace();
  if (offset !== text.length) throw new Error("Trailing JSON content");
}

export function canonicalHash(value: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(value)));
}

export interface RecipeNonceInput {
  chainId: number;
  canonicalToken: Address;
  payer: Address;
  splitter: Address;
  grossAmount: bigint;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  quoteHash: Hex;
  canonicalRequestHash: Hex;
  orderNonce: Hex;
}

export function recipeNonce(input: RecipeNonceInput): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      keccak256(stringToHex("DaskiStandardExactOrderV1")),
      BigInt(input.chainId),
      input.canonicalToken,
      input.payer,
      input.splitter,
      input.grossAmount,
      input.listingManifestHash,
      input.providerOfferHash,
      input.quoteHash,
      input.canonicalRequestHash,
      input.orderNonce,
    ],
  ));
}

export function artifactPayloadHash(envelope: {
  signature?: Hex;
  [key: string]: unknown;
}): Hex {
  const { signature: _signature, ...unsigned } = envelope;
  return canonicalHash(unsigned);
}

export function providerIdentitySnapshotHash(
  snapshot: ProviderIdentitySnapshotV1,
  chainId: number,
): Hex {
  const typeHash = keccak256(stringToHex(
    "ProviderIdentitySnapshotV1(uint256 chainId,uint256 providerAgentId,bytes32 serviceId,address identityRegistry,address providerRegistry,address serviceRegistry,address providerOwner,address providerAgentWallet,address providerPayee,uint256 blockNumber,bytes32 blockHash)",
  ));
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" },
    { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" },
    { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" },
  ], [
    typeHash, BigInt(chainId), BigInt(snapshot.providerAgentId), snapshot.serviceId,
    snapshot.identityRegistry, snapshot.providerRegistry, snapshot.serviceRegistry,
    snapshot.providerOwner, snapshot.providerAgentWallet, snapshot.providerPayee,
    BigInt(snapshot.blockNumber), snapshot.blockHash,
  ]));
}
