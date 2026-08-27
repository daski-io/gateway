import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { MarketplaceChainReader } from "../src/marketplace/reader.js";
import { verifyRegistrationIntent } from "../src/serviceRegistration/auth.js";
import { signEnvelope } from "../src/standardRail/signing.js";

const authorityKey = `0x${"11".repeat(32)}` as Hex;
const otherKey = `0x${"22".repeat(32)}` as Hex;
const serviceId = `0x${"33".repeat(32)}` as Hex;
const skillContractHash = `0x${"44".repeat(32)}` as Hex;
const skillContractSetHash = `0x${"55".repeat(32)}` as Hex;
const serviceContractHash = `0x${"88".repeat(32)}` as Hex;
const railPolicyHash = `0x${"66".repeat(32)}` as Hex;
const registrationNonce = `0x${"77".repeat(32)}` as Hex;

function marketplace(
  owner = privateKeyToAccount(authorityKey).address,
  providerAgentId = "42",
) {
  return {
    addresses: {} as MarketplaceChainReader["addresses"],
    resolveWallet: async () => ({ agentId: providerAgentId, found: true }),
    listProviders: async () => ({}),
    getService: async () => {
      throw new Error("not used");
    },
    getProvider: async () => ({
      agentId: providerAgentId,
      active: true,
      identity: {
        owner,
        agentWallet: getAddress("0x0000000000000000000000000000000000000042"),
      },
    }),
  } as MarketplaceChainReader;
}

async function intent(
  privateKey = authorityKey,
  audience = "https://gateway.example",
  providerAgentId = "42",
) {
  const now = Math.floor(Date.now() / 1_000);
  return signEnvelope({
    artifactType: "ProviderServiceRegistrationIntentV1",
    environment: "testnet",
    chainId: 84_532,
    audience,
    signerKeyId: "provider-authority",
    privateKey,
    issuedAt: now - 1,
    validBefore: now + 300,
    payload: {
      providerAgentId,
      serviceId,
      serviceSlug: "orbital-logistics",
      serviceVersion: "1",
      providerPayee: getAddress(
        "0x0000000000000000000000000000000000000042",
      ),
      serviceContractHash,
      skillContractSetHash,
      skills: [{ skillId: "reserve-orbit", skillContractHash }],
      railPolicyHash,
      registrationNonce,
    },
  });
}

const domain = {
  config: {
    chainId: 84_532 as const,
    publicUrl: "https://gateway.example",
  },
  railConfig: { environment: "testnet" },
};

describe("provider registration authentication", () => {
  it("accepts a short-lived intent signed by the finalized provider authority", async () => {
    const verified = await verifyRegistrationIntent({
      raw: await intent(),
      ...domain,
      marketplace: marketplace(),
    });
    expect(verified.envelope.payload.providerAgentId).toBe("42");
    expect(verified.signer).toBe(privateKeyToAccount(authorityKey).address);
  });

  it("accepts canonical ERC-8004 provider agent id zero", async () => {
    const verified = await verifyRegistrationIntent({
      raw: await intent(authorityKey, domain.config.publicUrl, "0"),
      ...domain,
      marketplace: marketplace(
        privateKeyToAccount(authorityKey).address,
        "0",
      ),
    });
    expect(verified.envelope.payload.providerAgentId).toBe("0");
  });

  it("rejects cross-gateway replay", async () => {
    await expect(verifyRegistrationIntent({
      raw: await intent(authorityKey, "https://other-gateway.example"),
      ...domain,
      marketplace: marketplace(),
    })).rejects.toThrow("domain or validity");
  });

  it("rejects a signer that is not the current owner or agent wallet", async () => {
    await expect(verifyRegistrationIntent({
      raw: await intent(otherKey),
      ...domain,
      marketplace: marketplace(),
    })).rejects.toThrow("current provider authority");
  });
});
