import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keccak256, toBytes, type PublicClient } from "viem";
import { EAS_PROFILES, EasIncompatible, easDomainSeparator, observeEasProfile, signedDeadlineExpired } from "../src/standardRail/easProfiles.js";

const FIXTURES = [["base-8453.json", 8453, "eas-native-1.0.1"], ["base-84532.json", 84532, "eas-native-1.2.0"],
  ["base-84532-eas-1.4.1-beta.3.json", 84532, "eas-native-1.4.1-beta.3"], ["base-8453-eas-1.4.1-beta.3.json", 8453, "eas-native-1.4.1-beta.3"]] as const;
const load = (file: string) => JSON.parse(readFileSync(new URL("./fixtures/eas/" + file, import.meta.url), "utf8"));
for (const [file, chainId, profileId] of FIXTURES) {
  const fixture = load(file);
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
  const others = FIXTURES.filter(([other]) => other !== file).map(([other]) => load(other));
  describe("native EAS " + fixture.version + " deployment on chain " + chainId, () => {
    it("qualifies its signing format from independently recomputed domain/types and records the runtime as evidence", async () => {
      expect(fixture.chainId).toBe(chainId);
      const observed = await observeEasProfile(client(), chainId, fixture.eas.address, "finalized");
      expect(observed.profileId).toBe(profileId);
      const profile = EAS_PROFILES[observed.profileId];
      expect(observed.contractVersion).toBe(fixture.version);
      expect(observed.implementation.toLowerCase()).toBe(fixture.eas.implementation.toLowerCase());
      expect(observed.implementationCodeHash).toBe(keccak256(fixture.eas.runtimeCode));
      expect(observed.blockHash).toBe(fixture.blockHash);
      expect(easDomainSeparator(chainId, fixture.eas.address, profile.domainVersion)).toBe(fixture.getDomainSeparator);
      const hash = (name: string, fields: readonly { name: string; type: string }[]) =>
        keccak256(toBytes(name + "(" + fields.map(field => field.type + " " + field.name).join(",") + ")"));
      expect(hash("Attest", profile.attestTypes.Attest)).toBe(fixture.getAttestTypeHash);
      expect(hash("Revoke", profile.revokeTypes.Revoke)).toBe(fixture.getRevokeTypeHash);
    });
    it("keeps qualifying an in-place upgrade that keeps the signing format", async () => {
      const upgraded = { version: "9.9.9", code: "0x60806040", slot: "0x" + "0".repeat(24) + "11".repeat(20) };
      const observed = await observeEasProfile(client(upgraded), chainId, fixture.eas.address);
      expect(observed).toMatchObject({ profileId, contractVersion: "9.9.9", implementationCodeHash: keccak256("0x60806040") });
    });
    it.each([
      { getDomainSeparator: "0x" + "ff".repeat(32) },
      { getAttestTypeHash: "0x" + "ff".repeat(32) },
      { getRevokeTypeHash: "0x" + "ff".repeat(32) },
      ...others.filter(other => other.getDomainSeparator !== fixture.getDomainSeparator).map(other => ({ getDomainSeparator: other.getDomainSeparator })),
      ...others.filter(other => other.getAttestTypeHash !== fixture.getAttestTypeHash).map(other => ({ getAttestTypeHash: other.getAttestTypeHash })),
      { code: "0x" },
      { slot: "0x" + "00".repeat(32) },
      { chainId: 1 },
    ])("rejects a changed signing identity %j", async (change) => {
      await expect(observeEasProfile(client(change), chainId, fixture.eas.address)).rejects.toThrow(EasIncompatible);
    });
    it("refuses a recognized format on an unqualified target or chain", async () => {
      await expect(observeEasProfile(client(), chainId, "0x1111111111111111111111111111111111111111")).rejects.toThrow(EasIncompatible);
      await expect(observeEasProfile(client({ chainId: 1 }), 1, fixture.eas.address)).rejects.toThrow(EasIncompatible);
    });
  });
}
it("each signing format is distinct, so at most one matches a deployment", () => {
  const profiles = Object.values(EAS_PROFILES);
  for (const key of ["domainVersion", "attestTypeHash", "revokeTypeHash"] as const) {
    expect(new Set(profiles.map(profile => profile[key])).size).toBe(profiles.length);
  }
});
it("the observed Sepolia runtimes expire strictly AFTER their deadline; legacy and zero never expire", () => {
  expect(signedDeadlineExpired("eas-native-1.2.0", "100", 99n)).toBe(false);
  expect(signedDeadlineExpired("eas-native-1.2.0", "100", 100n)).toBe(false);
  expect(signedDeadlineExpired("eas-native-1.2.0", "100", 101n)).toBe(true);
  expect(signedDeadlineExpired("eas-native-1.2.0", "0", 101n)).toBe(false);
  expect(signedDeadlineExpired("eas-native-1.4.1-beta.3", "100", 100n)).toBe(false);
  expect(signedDeadlineExpired("eas-native-1.4.1-beta.3", "100", 101n)).toBe(true);
  expect(signedDeadlineExpired("eas-native-1.0.1", null, 100000n)).toBe(false);
});
