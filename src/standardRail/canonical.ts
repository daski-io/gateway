import { encodeAbiParameters, keccak256, stringToHex, type Address } from "viem";
import type { Hex } from "../types.js";

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

function canonicalValue(value: unknown): string {
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
    return `[${value.map(canonicalValue).join(",")}]`;
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
    const child = object[key];
    if (child === undefined) throw new Error("Canonical JSON contains undefined");
    return `${JSON.stringify(key)}:${canonicalValue(child)}`;
  }).join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function assertNoDuplicateJsonKeys(text: string): void {
  let offset = 0;
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
  const value = (): void => {
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
        if (keys.has(key)) throw new Error(`Duplicate JSON key ${key}`);
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") throw new Error("JSON colon expected");
        offset += 1;
        value();
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
        value();
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
  value();
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
