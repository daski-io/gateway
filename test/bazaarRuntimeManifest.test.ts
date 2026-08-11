import { describe, expect, it } from "vitest";
import { computeBazaarRuntimeManifestIdentity } from "../src/bazaar/runtimeManifest.js";
import { createBazaarHarness } from "./helpers/bazaar.js";

describe("Bazaar runtime manifest", () => {
  const identity = (
    wiring: Parameters<typeof computeBazaarRuntimeManifestIdentity>[0],
    retentionSeconds = 3_600,
  ) => computeBazaarRuntimeManifestIdentity(wiring, retentionSeconds);

  it("hashes unordered declarative collections deterministically", async () => {
    const harness = await createBazaarHarness();
    const policy = harness.wiring.refundRiskPolicies["701"]!;
    const first = {
      ...harness.wiring,
      approvedTermsOrigins: ["https://z.example", "https://a.example"],
      refundRiskPolicies: {
        "702": { ...policy },
        "701": policy,
      },
    };
    const second = {
      ...first,
      approvedTermsOrigins: [...first.approvedTermsOrigins].reverse(),
      refundRiskPolicies: {
        "701": policy,
        "702": { ...policy },
      },
    };

    expect(identity(first).hash).toBe(
      identity(second).hash,
    );
  });

  it("binds policy, secret, and epoch changes", async () => {
    const harness = await createBazaarHarness();
    const original = identity(harness.wiring);
    const policyChange = identity({
      ...harness.wiring,
      adapterCallTimeoutMs: harness.wiring.adapterCallTimeoutMs - 1,
    });
    const secretChange = identity({
      ...harness.wiring,
      challengeMac: {
        ...harness.wiring.challengeMac,
        current: {
          ...harness.wiring.challengeMac.current,
          secret: Buffer.from("ef".repeat(32), "hex"),
        },
      },
    });
    const epochChange = identity({
      ...harness.wiring,
      runtimeManifestEpoch: harness.wiring.runtimeManifestEpoch + 1n,
    });

    expect(policyChange.hash).not.toBe(original.hash);
    expect(secretChange.hash).not.toBe(original.hash);
    expect(epochChange.hash).not.toBe(original.hash);
    expect(identity(harness.wiring, 3_601).hash).not.toBe(original.hash);
  });
});
