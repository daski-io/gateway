import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keccak256, toBytes, type PublicClient } from "viem";
import { EAS_PROFILES, EasIncompatible, easDomainSeparator, observeEasProfile, signedDeadlineExpired } from "../src/standardRail/easProfiles.js";

for (const chainId of [8453, 84532]) {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/eas/base-" + chainId + ".json", import.meta.url), "utf8"));
  function client(overrides: Record<string, unknown> = {}): PublicClient {
    const values: Record<string, unknown> = { version: fixture.version, getDomainSeparator: fixture.getDomainSeparator,
      getAttestTypeHash: fixture.getAttestTypeHash, getRevokeTypeHash: fixture.getRevokeTypeHash, ...overrides };
    return {
      getChainId: async () => overrides.chainId ?? chainId,
      getBlock: async () => ({ number: BigInt(fixture.blockNumber), hash: fixture.blockHash, timestamp: BigInt(fixture.blockTimestamp) }),
      getStorageAt: async () => overrides.slot ?? "0x" + "0".repeat(24) + fixture.eas.implementation.slice(2),
      getCode: async () => overrides.code ?? fixture.eas.runtimeCode,
      readContract: async ({ functionName }: { functionName: string }) => values[functionName],
    } as unknown as PublicClient;
  }
  describe("native EAS profile on chain " + chainId, () => {
    it("accepts the exact pinned deployed runtime and independently recomputed domain/types", async () => {
      const observed = await observeEasProfile(client(), chainId, fixture.eas.address, "finalized");
      const profile = EAS_PROFILES[observed.profileId];
      expect(observed.implementationCodeHash).toBe(keccak256(fixture.eas.runtimeCode));
      expect(observed.blockHash).toBe(fixture.blockHash);
      expect(easDomainSeparator(chainId, fixture.eas.address, profile.domainVersion)).toBe(fixture.getDomainSeparator);
      const hash = (name: string, fields: readonly { name: string; type: string }[]) =>
        keccak256(toBytes(name + "(" + fields.map(field => field.type + " " + field.name).join(",") + ")"));
      expect(hash("Attest", profile.attestTypes.Attest)).toBe(fixture.getAttestTypeHash);
      expect(hash("Revoke", profile.revokeTypes.Revoke)).toBe(fixture.getRevokeTypeHash);
    });
    it.each([
      { version: "1.4.1-beta.3" },
      { getDomainSeparator: "0x" + "ff".repeat(32) },
      { getAttestTypeHash: "0x" + "ff".repeat(32) },
      { getRevokeTypeHash: "0x" + "ff".repeat(32) },
      { code: "0x60806040" },
      { slot: "0x" + "00".repeat(32) },
      { chainId: 1 },
    ])("rejects identity tampering %j", async (change) => {
      await expect(observeEasProfile(client(change), chainId, fixture.eas.address)).rejects.toThrow(EasIncompatible);
    });
    it("refuses an otherwise recognized implementation on an unqualified target", async () => {
      await expect(observeEasProfile(client(), chainId, "0x1111111111111111111111111111111111111111")).rejects.toThrow(EasIncompatible);
    });
  });
}
it("the observed Sepolia runtime expires strictly AFTER its deadline; legacy and zero never expire", () => {
  expect(signedDeadlineExpired("eas-native-1.2.0", "100", 99n)).toBe(false);
  expect(signedDeadlineExpired("eas-native-1.2.0", "100", 100n)).toBe(false);
  expect(signedDeadlineExpired("eas-native-1.2.0", "100", 101n)).toBe(true);
  expect(signedDeadlineExpired("eas-native-1.2.0", "0", 101n)).toBe(false);
  expect(signedDeadlineExpired("eas-native-1.0.1", null, 100000n)).toBe(false);
});
