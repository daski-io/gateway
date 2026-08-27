import { describe, expect, it } from "vitest";
import { recipeNonceV2 } from "../src/standardRail/canonical.js";
import {
  buildRuntimeListingCommitment,
  runtimeCommitmentHash,
  type RuntimeCommitmentInputs,
} from "../src/serviceRegistration/runtimeCommitment.js";
import type {
  GatewayListingPreparationV1,
  GatewaySkillControlProfileV1,
} from "../src/serviceRegistration/types.js";
import type { SignedEnvelope } from "../src/standardRail/types.js";

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const address = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`;

function preparationEnvelope(): SignedEnvelope<GatewayListingPreparationV1> {
  return {
    artifactType: "GatewayListingPreparationV1",
    schemaVersion: 1,
    environment: "base-sepolia",
    chainId: 84532,
    audience: "https://gateway.example",
    signerKeyId: "standard-rail-signer",
    issuedAt: 1_700_000_000,
    validBefore: 2_015_360_000,
    payload: {
      registrationId: "11111111-1111-4111-8111-111111111111",
      listingId: "22222222-2222-4222-8222-222222222222",
      listingKey: hash("8"),
      providerAgentId: "42",
      serviceId: hash("1"),
      serviceSlug: "orbital-logistics",
      serviceVersion: "1",
      skillId: "reserve-orbit",
      skillContractHash: hash("5"),
      skillContractSetHash: hash("4"),
      providerIntentHash: hash("7"),
      canonicalToken: address("a"),
      providerPayee: address("b"),
      daskiCommissionReceiver: address("c"),
      commissionBps: 500,
      splitterFactory: address("d"),
      splitterDeploymentSalt: hash("9"),
      policyVersionHash: hash("6"),
      listingEpoch: "3",
    },
    signature: `0x${"ab".repeat(65)}` as `0x${string}`,
  };
}

function controlProfileEnvelope(): SignedEnvelope<GatewaySkillControlProfileV1> {
  return {
    artifactType: "GatewaySkillControlProfileV1",
    schemaVersion: 1,
    environment: "base-sepolia",
    chainId: 84532,
    audience: "https://gateway.example",
    signerKeyId: "standard-rail-signer",
    issuedAt: 1_700_000_000,
    validBefore: 2_015_360_000,
    payload: {
      registrationId: "11111111-1111-4111-8111-111111111111",
      providerAgentId: "42",
      providerIntentHash: hash("7"),
      serviceId: hash("1"),
      serviceSlug: "orbital-logistics",
      skillId: "reserve-orbit",
      skillContractHash: hash("5"),
      policyVersionHash: hash("6"),
      providerEndpoint: "https://provider.example/standard-rail/assets/action",
      ownershipPolicy: "owner-only",
      effect: "read",
      replayPolicy: "stable-result",
      retentionSeconds: 3600,
      walletAuthorizationRequired: true,
      delayedConfirmationRequired: false,
      confirmationSummarySchemaHash: null,
      confirmationSummaryTemplateHash: null,
    },
    signature: `0x${"cd".repeat(65)}` as `0x${string}`,
  };
}

function inputs(overrides: Partial<RuntimeCommitmentInputs["listing"]> = {}): RuntimeCommitmentInputs {
  return {
    environment: "base-sepolia",
    chainId: 84532,
    gatewayAudience: "https://gateway.example",
    providerAgentId: "42",
    serviceId: hash("1"),
    currentProviderIntentHash: hash("f"),
    currentProviderPayee: address("b"),
    policy: {
      canonicalToken: address("a"),
      daskiCommissionReceiver: address("c"),
      commissionBps: 500,
      policyVersionHash: hash("6"),
      splitterFactory: address("d"),
    },
    listing: {
      listingId: "33333333-3333-4333-8333-333333333333",
      listingKey: hash("8"),
      skillId: "reserve-orbit",
      skillContractHash: hash("5"),
      paymentRequired: true,
      splitterAddress: address("e"),
      preparation: preparationEnvelope(),
      controlProfile: controlProfileEnvelope(),
      ...overrides,
    },
  };
}

describe("runtime listing commitment", () => {
  it("derives paid identity from the original preparation envelope", () => {
    const commitment = buildRuntimeListingCommitment(inputs());
    expect(commitment.listingId).toBe("22222222-2222-4222-8222-222222222222");
    expect(commitment.providerIntentHash).toBe(hash("7"));
    expect(commitment.listingEpoch).toBe("3");
    expect(commitment.preparationHash).not.toBeNull();
    expect(commitment.controlProfileHash).not.toBeNull();
  });

  it("does not rotate an unchanged listing when the registration changes", () => {
    const original = runtimeCommitmentHash(buildRuntimeListingCommitment(inputs()));
    const reRegistered = runtimeCommitmentHash(buildRuntimeListingCommitment({
      ...inputs({ listingId: "44444444-4444-4444-8444-444444444444" }),
      currentProviderIntentHash: hash("0"),
      currentProviderPayee: address("9"),
    }));
    expect(reRegistered).toBe(original);
  });

  it("binds free skills to the current registration intent", () => {
    const commitment = buildRuntimeListingCommitment(inputs({
      paymentRequired: false,
      splitterAddress: null,
      preparation: null,
      controlProfile: null,
    }));
    expect(commitment.providerIntentHash).toBe(hash("f"));
    expect(commitment.listingEpoch).toBe("0");
    expect(commitment.preparationHash).toBeNull();
    expect(commitment.splitterFactory).toBeNull();
  });

  it("rejects deployment artifacts that disagree with the payment mode", () => {
    expect(() => buildRuntimeListingCommitment(inputs({ preparation: null })))
      .toThrow(/payment mode/);
    expect(() => buildRuntimeListingCommitment(inputs({ splitterAddress: null })))
      .toThrow(/payment mode/);
    expect(() => buildRuntimeListingCommitment(inputs({ paymentRequired: false })))
      .toThrow(/payment mode/);
  });

  it("rejects a preparation describing another skill", () => {
    const preparation = preparationEnvelope();
    preparation.payload.skillId = "other-skill";
    expect(() => buildRuntimeListingCommitment(inputs({ preparation })))
      .toThrow(/does not describe this skill/);
  });

  it("matches the shared golden vectors", () => {
    const paid = buildRuntimeListingCommitment(inputs());
    const free = buildRuntimeListingCommitment(inputs({
      paymentRequired: false,
      splitterAddress: null,
      preparation: null,
      controlProfile: null,
    }));
    expect(runtimeCommitmentHash(paid))
      .toBe("0xd0dcaeaf88bce6b478d793d42ce33e4154dd859139acaa0850ab2fddfa4fdb70");
    expect(runtimeCommitmentHash(free))
      .toBe("0x5caad8a68dce18b33c11c5b75b0a3efe7649678899a5fcd9c3df8ddc3a91b662");
    expect(recipeNonceV2({
      chainId: 84532,
      canonicalToken: address("a"),
      payer: address("1"),
      splitter: address("e"),
      grossAmount: 1_250_000n,
      runtimeCommitmentHash: runtimeCommitmentHash(paid),
      providerIntentHash: paid.providerIntentHash,
      quoteHash: hash("0"),
      canonicalRequestHash: hash("2"),
      orderNonce: hash("3"),
    })).toBe("0x6e421e6825b79637e4f46a3d0c64ae4146ae1ad218380973eadc871f5f6d1dd3");
  });
});
