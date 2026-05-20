import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { skillIdHash } from "../src/payment/requirements.js";

/**
 * Unit tests for the skillIdHash helper used by the off-chain skill
 * binding in `generateServiceRef`. The contract is:
 *   - Deterministic (same skillId → same hash)
 *   - 32 bytes (0x + 64 hex chars)
 *   - keccak256 of the UTF-8 bytes of the input — so anyone holding the
 *     original skill string can recompute and verify the binding.
 */
describe("skillIdHash", () => {
  it("returns a 32-byte hex value", () => {
    const h = skillIdHash("register-domain");
    expect(/^0x[0-9a-f]{64}$/.test(h)).toBe(true);
  });

  it("is deterministic", () => {
    expect(skillIdHash("register-domain")).toBe(skillIdHash("register-domain"));
    expect(skillIdHash("transfer-out")).toBe(skillIdHash("transfer-out"));
  });

  it("differentiates skill IDs", () => {
    expect(skillIdHash("register-domain")).not.toBe(skillIdHash("transfer-out"));
    expect(skillIdHash("register-domain")).not.toBe(skillIdHash("Register-Domain"));
  });

  it("matches keccak256(utf8 bytes) — the documented derivation", () => {
    // Anyone with the skill string can recompute the binding using only
    // viem primitives — no Daski-specific code required.
    const skill = "register-domain";
    const expected = keccak256(stringToBytes(skill));
    expect(skillIdHash(skill)).toBe(expected);
  });

  it("handles unicode skill IDs", () => {
    // UTF-8 encoding matters for non-ASCII skill IDs. The hash should
    // match the canonical UTF-8 keccak, not a latin-1 collapse.
    const skill = "登録-ドメイン";
    const expected = keccak256(stringToBytes(skill));
    expect(skillIdHash(skill)).toBe(expected);
  });
});
