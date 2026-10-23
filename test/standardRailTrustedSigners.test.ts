import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyEnvelope, type ArtifactTrust } from "../src/standardRail/artifacts.js";
import { signEnvelope } from "../src/standardRail/signing.js";

const earlier = `0x${"21".repeat(32)}` as const;
const later = `0x${"22".repeat(32)}` as const;
const outsider = `0x${"23".repeat(32)}` as const;
const now = Math.floor(Date.now() / 1_000);

function trust(signers: ArtifactTrust["signers"]): ArtifactTrust {
  return {
    environment: "testnet",
    chainId: 84532,
    gatewayAudience: "https://gateway.example.test",
    signers,
    splitterFactoryRuntimeCodeHash: `0x${"1".repeat(64)}`,
    splitterCreationCodeHash: `0x${"2".repeat(64)}`,
  };
}

function envelope(privateKey: `0x${string}`, signerKeyId = "gateway-protocol") {
  return signEnvelope({
    artifactType: "ChainEvidencePolicyV2",
    schemaVersion: 2,
    environment: "testnet",
    chainId: 84532,
    audience: "https://gateway.example.test",
    signerKeyId,
    privateKey,
    issuedAt: now - 10,
    validBefore: now + 3_600,
    payload: { policyId: "rotation-test" },
  });
}

describe("manifest artifacts across a signer rotation", () => {
  it("verifies artifacts from every address listed for their key ID, and no other", async () => {
    const rotated = trust(new Map([["gateway-protocol", [
      privateKeyToAccount(earlier).address,
      privateKeyToAccount(later).address,
    ]]]));
    await expect(verifyEnvelope(await envelope(earlier), "ChainEvidencePolicyV2", rotated)).resolves.toBeUndefined();
    await expect(verifyEnvelope(await envelope(later), "ChainEvidencePolicyV2", rotated)).resolves.toBeUndefined();
    await expect(verifyEnvelope(await envelope(outsider), "ChainEvidencePolicyV2", rotated))
      .rejects.toThrow(/signature is invalid/);
    await expect(verifyEnvelope(await envelope(later, "other-key"), "ChainEvidencePolicyV2", rotated))
      .rejects.toThrow(/Unknown artifact signer other-key/);
  });

  it("keeps the single-address form and refuses a key ID with no address", async () => {
    const single = trust(new Map([["gateway-protocol", privateKeyToAccount(earlier).address]]));
    await expect(verifyEnvelope(await envelope(earlier), "ChainEvidencePolicyV2", single)).resolves.toBeUndefined();
    await expect(verifyEnvelope(await envelope(later), "ChainEvidencePolicyV2", single))
      .rejects.toThrow(/signature is invalid/);
    await expect(verifyEnvelope(await envelope(earlier), "ChainEvidencePolicyV2", trust(new Map([["gateway-protocol", []]]))))
      .rejects.toThrow(/Unknown artifact signer gateway-protocol/);
  });
});
