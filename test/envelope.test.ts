import { describe, expect, it } from "vitest";
import {
  buildEnvelopeAuth,
  canonicalJsonStringify,
  computeRequestHash,
} from "../src/auth/envelope.js";
import { providerAgentIdDomainSalt } from "../src/auth/providerDomain.js";

describe("signed request canonicalization", () => {
  it("isolates envelope signatures by provider agent ID", () => {
    const envelope = buildEnvelopeAuth({
      buyerTokenId: "5",
      skillId: "test",
      paymentId: "0",
      chainId: 84532,
      identityRegistryAddress:
        "0x000000000000000000000000000000000000a000",
      providerAgentId: 2n,
      messageId: "provider-domain-test",
      issuedAt: 1,
    });
    expect(envelope.eip712TypedData.domain.salt).toBe(
      providerAgentIdDomainSalt(2n),
    );
    expect(envelope.eip712TypedData.domain.salt).not.toBe(
      providerAgentIdDomainSalt(1n),
    );
  });

  it("is deterministic for nested objects", () => {
    expect(canonicalJsonStringify({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects the unsafe key %s at any depth",
    (key) => {
      const args = JSON.parse(
        `{"safe":true,"nested":{"${key}":{"role":"admin"}}}`,
      ) as Record<string, unknown>;
      expect(() => computeRequestHash(args)).toThrow(
        `unsafe object key in signed JSON: ${key}`,
      );
    },
  );

  it("does not allow distinct prototype payloads to share a hash", () => {
    const first = JSON.parse(
      '{"safe":2,"__proto__":{"role":"user"}}',
    ) as Record<string, unknown>;
    const second = JSON.parse(
      '{"safe":2,"__proto__":{"role":"admin"}}',
    ) as Record<string, unknown>;
    expect(() => computeRequestHash(first)).toThrow();
    expect(() => computeRequestHash(second)).toThrow();
  });
});
