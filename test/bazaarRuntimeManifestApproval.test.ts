import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { computeBazaarRuntimeManifestIdentity } from
  "../src/bazaar/runtimeManifest.js";
import {
  bazaarRuntimeManifestApprovalTypedData,
  bazaarRuntimeManifestApprovalDigest,
  validateBazaarRuntimeManifestApproval,
} from "../src/bazaar/runtimeManifestApproval.js";
import {
  createBazaarHarness,
  TEST_LIFECYCLE_RETENTION_SECONDS,
  TEST_NOW,
} from "./helpers/bazaar.js";

describe("Bazaar runtime manifest approval", () => {
  it("accepts a fresh owner approval and derives a stable audit digest", async () => {
    const harness = await createBazaarHarness();
    const identity = computeBazaarRuntimeManifestIdentity(
      harness.wiring,
      TEST_LIFECYCLE_RETENTION_SECONDS,
    );
    const approved = await validateBazaarRuntimeManifestApproval({
      identity,
      approval: harness.wiring.runtimeManifestApproval,
      trust: harness.runtimeManifestTrust,
      wiring: harness.wiring,
      now: nowSeconds(),
    });
    expect(approved).toMatchObject({
      ...identity,
      approvalAuthority: harness.runtimeManifestTrust.authority.toLowerCase(),
      deploymentId: harness.runtimeManifestTrust.deploymentId.toLowerCase(),
    });
    expect(bazaarRuntimeManifestApprovalDigest({
      identity,
      approval: harness.wiring.runtimeManifestApproval,
      trust: harness.runtimeManifestTrust,
    })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects adapter drift and cross-deployment approval replay", async () => {
    const harness = await createBazaarHarness();
    harness.wiring.facilitator.identity.configurationHash =
      `0x${"12".repeat(32)}`;
    const drifted = computeBazaarRuntimeManifestIdentity(
      harness.wiring,
      TEST_LIFECYCLE_RETENTION_SECONDS,
    );
    await expect(validateBazaarRuntimeManifestApproval({
      identity: drifted,
      approval: harness.wiring.runtimeManifestApproval,
      trust: harness.runtimeManifestTrust,
      wiring: harness.wiring,
      now: nowSeconds(),
    })).rejects.toThrow(/approval authority is invalid/);

    const original = await createBazaarHarness();
    const identity = computeBazaarRuntimeManifestIdentity(
      original.wiring,
      TEST_LIFECYCLE_RETENTION_SECONDS,
    );
    await expect(validateBazaarRuntimeManifestApproval({
      identity,
      approval: original.wiring.runtimeManifestApproval,
      trust: {
        ...original.runtimeManifestTrust,
        deploymentId: `0x${"13".repeat(32)}`,
      },
      wiring: original.wiring,
      now: nowSeconds(),
    })).rejects.toThrow(/approval authority is invalid/);
  });

  it("rejects stale approval and a trust root reused from a provider role", async () => {
    const harness = await createBazaarHarness();
    const identity = computeBazaarRuntimeManifestIdentity(
      harness.wiring,
      TEST_LIFECYCLE_RETENTION_SECONDS,
    );
    harness.wiring.runtimeManifestApproval.validBefore = nowSeconds();
    await expect(validateBazaarRuntimeManifestApproval({
      identity,
      approval: harness.wiring.runtimeManifestApproval,
      trust: harness.runtimeManifestTrust,
      wiring: harness.wiring,
      now: nowSeconds(),
    })).rejects.toThrow(/malformed or stale/);

    const provider = privateKeyToAccount(
      `0x${"22".repeat(32)}`,
    );
    await expect(validateBazaarRuntimeManifestApproval({
      identity,
      approval: harness.wiring.runtimeManifestApproval,
      trust: { ...harness.runtimeManifestTrust, authority: provider.address },
      wiring: harness.wiring,
      now: nowSeconds(),
    })).rejects.toThrow(/purpose-separated/);
  });

  it("snapshots the trust anchor before asynchronous signature recovery", async () => {
    const harness = await createBazaarHarness();
    const identity = computeBazaarRuntimeManifestIdentity(
      harness.wiring,
      TEST_LIFECYCLE_RETENTION_SECONDS,
    );
    const replacement = privateKeyToAccount(`0x${"44".repeat(32)}`);
    const trust = { ...harness.runtimeManifestTrust };
    const approval = {
      ...harness.wiring.runtimeManifestApproval,
      signature: await replacement.signTypedData(
        bazaarRuntimeManifestApprovalTypedData({
          identity,
          approval: harness.wiring.runtimeManifestApproval,
          trust,
        }),
      ),
    };
    const validation = validateBazaarRuntimeManifestApproval({
      identity,
      approval,
      trust,
      wiring: harness.wiring,
      now: nowSeconds(),
    });
    trust.authority = replacement.address;
    await expect(validation).rejects.toThrow(/approval authority is invalid/);
  });

  it("returns the signed identity even if the caller mutates its object", async () => {
    const harness = await createBazaarHarness();
    const identity = computeBazaarRuntimeManifestIdentity(
      harness.wiring,
      TEST_LIFECYCLE_RETENTION_SECONDS,
    );
    const signedIdentity = { ...identity };
    const validation = validateBazaarRuntimeManifestApproval({
      identity,
      approval: harness.wiring.runtimeManifestApproval,
      trust: harness.runtimeManifestTrust,
      wiring: harness.wiring,
      now: nowSeconds(),
    });
    identity.epoch = 99n;
    identity.hash = `0x${"99".repeat(32)}`;
    await expect(validation).resolves.toMatchObject(signedIdentity);
  });
});

function nowSeconds(): bigint {
  return BigInt(Math.floor(TEST_NOW.getTime() / 1_000));
}
