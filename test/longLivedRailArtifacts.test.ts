import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyStandardRailManifest, type ArtifactTrust } from "../src/standardRail/artifacts.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { signEnvelope } from "../src/standardRail/signing.js";
import type { SignedEnvelope, StandardRailManifest } from "../src/standardRail/types.js";
import { PRIVATE_KEYS, RAIL_MANIFEST_EXAMPLES_DIR, type RailManifestExamples } from "./helpers/railManifestExamples.js";

// The start-up check on a manifest every date of which has passed
// (accepted.past-valid-before of the shared rail manifest examples), with the
// clock years later. No date expires it, but every relation between its dates
// still holds: a rail or facilitator profile whose dates are out of order, or
// an action definition that outlives its catalog, is refused at any clock.
// And what the release engine signs years later, a catalog epoch valid for
// five years from its signing chained onto the old one, is accepted.

const set = JSON.parse(readFileSync(path.join(RAIL_MANIFEST_EXAMPLES_DIR, "examples.json"), "utf8")) as RailManifestExamples;
const { manifest: past } = set.examples.find((example) => example.id === "accepted.past-valid-before")!;
const trust: ArtifactTrust = {
  environment: set.trust.environment, chainId: set.trust.chainId, gatewayAudience: set.trust.gatewayAudience,
  signers: new Map<string, readonly Address[]>(Object.entries(set.trust.trustedSigners)),
  splitterFactoryRuntimeCodeHash: `0x${"00".repeat(32)}`, splitterCreationCodeHash: `0x${"00".repeat(32)}`,
};
const account = privateKeyToAccount(PRIVATE_KEYS.manifestSigner);
const FIVE_YEARS = 5 * 365 * 86_400;
const CLOCKS = [["2027-04-01", Date.UTC(2027, 3, 1) / 1_000], ["2032-06-01", Date.UTC(2032, 5, 1) / 1_000]] as const;

type Envelope = SignedEnvelope<Record<string, unknown>, number>;
/** The envelope signed again over a changed payload and, optionally, a changed window. */
function resign<T extends object>(envelope: T, payload: Record<string, unknown>, window: object = {}): Promise<T> {
  const { signature: _signature, ...unsigned } = envelope as unknown as Envelope;
  return signEnvelope({ ...unsigned, schemaVersion: unsigned.schemaVersion as 1 | 2, ...window,
    payload: { ...unsigned.payload, ...payload }, account }) as Promise<T>;
}
const check = (manifest: unknown) => verifyStandardRailManifest(manifest as StandardRailManifest, trust);

afterEach(() => { vi.useRealTimers(); });

describe.each(CLOCKS)("a manifest past every date it carries, on %s", (_label, clock) => {
  const at = () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(clock * 1_000); };

  it("starts, every date of it being before the clock", async () => {
    at();
    for (const envelope of [past.facilitatorProfile, past.activeRailProfile, ...past.servicingAdmissions,
      ...past.actionCatalogs, ...past.providerControlProfiles]) expect(envelope.validBefore).toBeLessThan(clock);
    expect(past.activeRailProfile.payload.admissionValidBefore).toBeLessThan(clock);
    expect(past.servicingAdmissions[0]!.payload.validBefore).toBeLessThan(clock);
    expect(past.actionCatalogs[0]!.payload.actions[0]!.validBefore).toBeLessThan(clock);
    await expect(check(past)).resolves.toBeUndefined();
  });

  it.each([
    ["facilitator admission closes at its activation", "facilitatorProfile",
      (p: Record<string, number>) => ({ admissionValidBefore: p.activatedAt }), "Facilitator profile is invalid"],
    ["facilitator recovery ends at its admission", "facilitatorProfile",
      (p: Record<string, number>) => ({ recoveryValidBefore: p.admissionValidBefore }), "Facilitator profile is invalid"],
    ["facilitator activated before it is issued", "facilitatorProfile",
      (p: Record<string, number>) => ({ activatedAt: p.activatedAt - 1 }), "Facilitator profile is invalid"],
    ["rail admission closes at its activation", "activeRailProfile",
      (p: Record<string, number>) => ({ admissionValidBefore: p.activatedAt }),
      "Active rail profile chronology or predecessor is invalid"],
    ["rail recovery ends at its admission", "activeRailProfile",
      (p: Record<string, number>) => ({ recoveryValidBefore: p.admissionValidBefore }),
      "Active rail profile chronology or predecessor is invalid"],
    ["rail activated before it is issued", "activeRailProfile",
      (p: Record<string, number>) => ({ activatedAt: p.activatedAt - 1 }),
      "Active rail profile chronology or predecessor is invalid"],
  ] as const)("refuses dates out of order: %s", async (_case, key, change, error) => {
    at();
    const envelope = past[key] as unknown as Envelope;
    const changed = await resign(envelope, change(envelope.payload as Record<string, number>));
    await expect(check({ ...past, [key]: changed })).rejects.toThrow(new Error(error));
  });

  it.each(["facilitatorProfile", "activeRailProfile"] as const)(
    "refuses a %s whose recovery outlives its envelope", async (key) => {
      at();
      const envelope = past[key] as unknown as Envelope;
      const changed = await resign(envelope, { recoveryValidBefore: envelope.validBefore + 1 });
      await expect(check({ ...past, [key]: changed })).rejects.toThrow(
        key === "facilitatorProfile" ? "Facilitator profile is invalid" : "Active rail profile chronology or predecessor is invalid");
    });

  it("accepts a catalog epoch the release engine signs now, chained onto the old one, and refuses one that outlives its catalog", async () => {
    at();
    const [oldCatalog] = past.actionCatalogs as unknown as Envelope[];
    const [oldAdmission] = past.servicingAdmissions as unknown as Envelope[];
    const window = { issuedAt: clock, validBefore: clock + FIVE_YEARS };
    const [carried] = oldCatalog!.payload.actions as Array<Record<string, unknown>>;
    const { actionDefinitionHash: _hash, ...preimage } = carried!;
    const added = { ...preimage, actionId: "summarize-note", validFrom: clock, validBefore: clock + FIVE_YEARS };
    const sign = async (actions: Array<Record<string, unknown>>) => {
      const catalog = await resign(oldCatalog!, { actionCatalogEpoch: 2, actions }, window);
      const admission = await resign(oldAdmission!, {
        actionCatalogHash: canonicalHash(catalog), actionCatalogEpoch: 2, previousAdmissionHash: canonicalHash(oldAdmission),
        validFrom: clock, validBefore: clock + FIVE_YEARS,
      }, window);
      return { ...past, actionCatalogs: [oldCatalog, catalog], servicingAdmissions: [oldAdmission, admission] };
    };
    // The carried definition keeps its 2027 date; the new one is valid for five years.
    await expect(check(await sign([carried!, { ...added, actionDefinitionHash: canonicalHash(added) }])))
      .resolves.toBeUndefined();
    const outliving = { ...added, validBefore: clock + FIVE_YEARS + 1 };
    await expect(check(await sign([carried!, { ...outliving, actionDefinitionHash: canonicalHash(outliving) }])))
      .rejects.toThrow("Provider action definition is invalid");
  });
});
