import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  acceptInviteAdmission,
  approvalProfileEpoch,
  assertHostedLayout,
  buildProviderApprovalRecord,
  differsOnlyInResponseKey,
  PROVIDER_APPROVAL_SIGNER_KEY_ID,
  ProviderApprovalRefused,
} from "../src/providerApprovals/record.js";
import { assertProviderControlProfilePayload, verifyStandardRailManifest } from "../src/standardRail/artifacts.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { signEnvelope } from "../src/standardRail/signing.js";
import type { ProviderControlProfileV1, SignedEnvelope, StandardRailManifest } from "../src/standardRail/types.js";
import { HOSTED_AUDIENCE, HOSTED_ORIGIN, hostedBase, hostedCard, hostedStandardRail } from "./helpers/hostedProvider.js";
import { at } from "./helpers/providerWire.js";
import {
  CHAIN_ID, ENVIRONMENT, GATEWAY_AUDIENCE, NOW, PRIVATE_KEYS, RAIL_MANIFEST_EXAMPLES_DIR, TRUST,
  type RailManifestExamples,
} from "./helpers/railManifestExamples.js";

// The approval record a gateway builds for a hosted provider
// (docs/provider-approvals.md): its exact fields, the start-up check's payload
// rules it must pass, and the invite admission report that approves it.

const PROVIDER = "9101";
const wallet = (name: string) => privateKeyToAccount(keccak256(stringToHex(`approval record test: ${name}`))).address;
const AGENT_WALLET = wallet("agent wallet");
const OWNER = wallet("owner");
const DOMAIN = { environment: ENVIRONMENT, chainId: CHAIN_ID, gatewayAudience: GATEWAY_AUDIENCE };

const registration = (overrides: { card?: ReturnType<typeof hostedCard>; providerAgentWallet?: string } = {}) => ({
  providerAgentId: PROVIDER,
  providerAgentWallet: overrides.providerAgentWallet ?? AGENT_WALLET.toLowerCase(),
  card: overrides.card ?? hostedCard(PROVIDER),
});

const build = (overrides: Parameters<typeof registration>[0] = {}, manifestProfiles: SignedEnvelope<ProviderControlProfileV1>[] = []) =>
  buildProviderApprovalRecord({ domain: DOMAIN, registration: registration(overrides), manifestProfiles });

function refusal(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderApprovalRefused);
    return (error as ProviderApprovalRefused).code;
  }
  throw new Error("expected a refusal");
}

const committed = JSON.parse(
  readFileSync(path.join(RAIL_MANIFEST_EXAMPLES_DIR, "examples.json"), "utf8"),
) as RailManifestExamples;
const sharedOrigin: StandardRailManifest =
  committed.examples.find((example) => example.id === "accepted.shared-origin")!.manifest;

beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); at(NOW); });
afterAll(() => { vi.useRealTimers(); });

describe("the approval record", () => {
  it("is a ProviderControlProfileV1 envelope with the fixed approval fields and the card's texts verbatim", () => {
    const card = hostedCard(PROVIDER);
    const { record, recordHash } = build({ card });
    expect(record).toEqual({
      artifactType: "ProviderControlProfileV1",
      schemaVersion: 1,
      environment: ENVIRONMENT,
      chainId: CHAIN_ID,
      audience: GATEWAY_AUDIENCE,
      signerKeyId: PROVIDER_APPROVAL_SIGNER_KEY_ID,
      issuedAt: 0,
      validBefore: 0,
      payload: {
        providerAgentId: PROVIDER,
        providerAudience: HOSTED_AUDIENCE,
        origin: HOSTED_ORIGIN,
        quoteUrl: `${hostedBase(PROVIDER)}/standard-rail/quote`,
        dispatchUrl: `${hostedBase(PROVIDER)}/standard-rail/dispatch`,
        dispatchStatusUrl: `${hostedBase(PROVIDER)}/standard-rail/dispatch/status`,
        lifecycleUrl: `${hostedBase(PROVIDER)}/standard-rail/lifecycle`,
        assetQueryUrl: `${hostedBase(PROVIDER)}/standard-rail/assets/query`,
        assetActionUrl: `${hostedBase(PROVIDER)}/standard-rail/assets/action`,
        assetResponseKeyId: "provider-wallet",
        assetResponseKey: AGENT_WALLET,
        servicingProfileEpoch: 1,
        tlsPolicy: "webpki-v1",
        workloadAuthentication: "signed-envelopes-v1",
        maxResponseBytes: 524_288,
        timeoutMs: 90_000,
      },
      signature: "0x",
    });
    // Exactly the stored card's texts, and the response key checksummed.
    expect(Object.fromEntries(Object.keys(hostedStandardRail(PROVIDER)).map((name) =>
      [name, record.payload[name as keyof ProviderControlProfileV1]]))).toEqual(card.standardRail);
    expect(record.payload.assetResponseKey).toBe(getAddress(AGENT_WALLET));
    expect(record.payload.origin.endsWith("/")).toBe(false);
    expect(recordHash).toBe(canonicalHash(record));
  });

  it("hashes the same after a round trip through JSON with its keys in another order", () => {
    const { record, recordHash } = build();
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(record).reverse()))) as unknown;
    expect(canonicalHash(reordered)).toBe(recordHash);
  });

  it("takes one more than the provider's highest manifest epoch, ignoring other providers", async () => {
    const signed = (providerAgentId: string, servicingProfileEpoch: number) => signEnvelope({
      artifactType: "ProviderControlProfileV1", environment: ENVIRONMENT, chainId: CHAIN_ID, audience: GATEWAY_AUDIENCE,
      signerKeyId: "gateway-protocol", account: privateKeyToAccount(PRIVATE_KEYS.manifestSigner), issuedAt: NOW - 60,
      validBefore: NOW + 3_600,
      payload: { ...build().record.payload, providerAgentId, servicingProfileEpoch },
    }) as Promise<SignedEnvelope<ProviderControlProfileV1>>;
    const profiles = [await signed(PROVIDER, 1), await signed(PROVIDER, 3), await signed("9102", 7)];
    expect(approvalProfileEpoch(PROVIDER, [])).toBe(1);
    expect(approvalProfileEpoch(PROVIDER, profiles)).toBe(4);
    expect(approvalProfileEpoch("9103", profiles)).toBe(1);
    expect(build({}, profiles).record.payload.servicingProfileEpoch).toBe(4);
    // Above every earlier approval record too: the store asks for at least the next epoch.
    const epochOf = (manifestProfiles: SignedEnvelope<ProviderControlProfileV1>[], minimumEpoch: number) =>
      buildProviderApprovalRecord({ domain: DOMAIN, registration: registration(), manifestProfiles, minimumEpoch })
        .record.payload.servicingProfileEpoch;
    expect(epochOf([], 5)).toBe(5);
    expect(epochOf(profiles, 2)).toBe(4);
    expect(epochOf(profiles, 9)).toBe(9);
    for (const minimumEpoch of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(refusal(() => buildProviderApprovalRecord({ domain: DOMAIN, registration: registration(), manifestProfiles: [],
        minimumEpoch }))).toBe("PROVIDER_APPROVAL_EPOCH_INVALID");
    }
  });

  it("passes the payload rules of the start-up check, as a signed manifest profile with its payload does", async () => {
    const { record } = build();
    expect(() => assertProviderControlProfilePayload(record.payload)).not.toThrow();
    // The same payload, signed into a manifest beside the committed example's profiles, passes the whole check.
    const profile = await signEnvelope({
      artifactType: "ProviderControlProfileV1", environment: ENVIRONMENT, chainId: CHAIN_ID, audience: GATEWAY_AUDIENCE,
      signerKeyId: "gateway-protocol", account: privateKeyToAccount(PRIVATE_KEYS.manifestSigner), issuedAt: NOW - 60,
      validBefore: NOW + 3_600, payload: record.payload,
    });
    at(NOW);
    await expect(verifyStandardRailManifest({
      ...sharedOrigin, providerControlProfiles: [...sharedOrigin.providerControlProfiles, profile],
    }, {
      ...TRUST, signers: new Map(Object.entries(TRUST.trustedSigners)),
      splitterFactoryRuntimeCodeHash: `0x${"00".repeat(32)}`, splitterCreationCodeHash: `0x${"00".repeat(32)}`,
    })).resolves.toBeUndefined();
    // The record itself is never a manifest profile: its signer is no key.
    await expect(verifyStandardRailManifest({
      ...sharedOrigin, providerControlProfiles: [...sharedOrigin.providerControlProfiles, record],
    }, {
      ...TRUST, signers: new Map(Object.entries(TRUST.trustedSigners)),
      splitterFactoryRuntimeCodeHash: `0x${"00".repeat(32)}`, splitterCreationCodeHash: `0x${"00".repeat(32)}`,
    })).rejects.toThrow();
  });

  it("is refused for a card whose URLs the start-up check would refuse", () => {
    const withQuery = hostedCard(PROVIDER, { ...hostedStandardRail(PROVIDER),
      dispatchUrl: `${hostedBase(PROVIDER)}/standard-rail/dispatch?seller=${PROVIDER}` });
    expect(withQuery.standardRail.dispatchUrl).toContain("?");
    expect(refusal(() => build({ card: withQuery }))).toBe("PROVIDER_APPROVAL_PROFILE_INVALID");
    // A stored card whose texts are not the start-up check's (an origin with a path).
    const tampered = { ...hostedCard(PROVIDER) };
    tampered.standardRail = { ...tampered.standardRail, origin: `${HOSTED_ORIGIN}/p/${PROVIDER}` };
    expect(refusal(() => build({ card: tampered }))).toBe("PROVIDER_APPROVAL_PROFILE_INVALID");
    const missing = { ...hostedCard(PROVIDER) };
    missing.standardRail = { ...missing.standardRail, lifecycleUrl: undefined as unknown as string };
    expect(refusal(() => build({ card: missing }))).toBe("PROVIDER_APPROVAL_PROFILE_INVALID");
  });

  it("is refused for another provider's card or an invalid wallet", () => {
    expect(refusal(() => build({ card: hostedCard("9102") }))).toBe("PROVIDER_APPROVAL_IDENTITY_INVALID");
    expect(refusal(() => build({ providerAgentWallet: "0x1234" }))).toBe("PROVIDER_APPROVAL_WALLET_INVALID");
  });

  it("is held to the hosted runtime's layout: the bare origin, its audience and every URL under the seller's path", () => {
    const { record } = build();
    expect(() => assertHostedLayout(record)).not.toThrow();
    const changed = (payload: Partial<ProviderControlProfileV1>) => ({ ...record, payload: { ...record.payload, ...payload } });
    for (const payload of [
      { origin: `${HOSTED_ORIGIN}/` },
      { providerAudience: HOSTED_ORIGIN },
      { quoteUrl: `${HOSTED_ORIGIN}/p/9102/standard-rail/quote` },
      { dispatchUrl: `${hostedBase(PROVIDER)}/standard-rail/dispatch/` },
      { lifecycleUrl: `${HOSTED_ORIGIN}/standard-rail/lifecycle` },
      { assetActionUrl: `${hostedBase(PROVIDER)}/standard-rail/assets/actions` },
    ]) expect(refusal(() => assertHostedLayout(changed(payload)))).toBe("PROVIDER_APPROVAL_NOT_HOSTED_LAYOUT");
  });

  it("tells a response key rotation from any other change", () => {
    const { record } = build();
    const rotated = build({ providerAgentWallet: wallet("next agent wallet") }).record;
    expect(differsOnlyInResponseKey(rotated, record)).toBe(true);
    expect(differsOnlyInResponseKey(record, record)).toBe(false);
    expect(differsOnlyInResponseKey({ ...rotated, payload: { ...rotated.payload, servicingProfileEpoch: 2 } }, record)).toBe(false);
    expect(differsOnlyInResponseKey({ ...rotated, payload: { ...rotated.payload, providerAudience: "https://other.example/" } },
      record)).toBe(false);
  });
});

describe("the invite admission report", () => {
  const report = (invite: Record<string, unknown> | null, overrides: Record<string, unknown> = {}) => ({
    providerAgentId: PROVIDER, chainId: CHAIN_ID, invite, ...overrides,
  });
  const invite = (overrides: Record<string, unknown> = {}) => ({
    id: "a1b2c3d4e5f6", admissionAuthorized: true, authorizedAt: "2026-11-17T12:00:00.000Z",
    redeemedWallet: OWNER.toLowerCase(), ...overrides,
  });
  const expected = { providerAgentId: PROVIDER, chainId: CHAIN_ID, providerOwner: OWNER };
  const refusedWith = (raw: unknown) => refusal(() => acceptInviteAdmission(raw, expected));

  it("approves an authorized invite redeemed by the registration's owner, whatever the wallet's case", () => {
    expect(acceptInviteAdmission(report(invite()), expected)).toEqual({ inviteId: "a1b2c3d4e5f6" });
    expect(acceptInviteAdmission(report(invite({ redeemedWallet: OWNER })), expected).inviteId).toBe("a1b2c3d4e5f6");
    expect(acceptInviteAdmission(report(invite({ redeemedWallet: OWNER.toUpperCase().replace("0X", "0x") })), expected))
      .toEqual({ inviteId: "a1b2c3d4e5f6" });
    // Fields the gateway does not read are ignored.
    expect(acceptInviteAdmission({ ...report(invite({ note: "x" })), served: "now" }, expected).inviteId).toBe("a1b2c3d4e5f6");
  });

  it("refuses every other answer", () => {
    expect(refusedWith(null)).toBe("ADMISSION_REPORT_INVALID");
    expect(refusedWith([report(invite())])).toBe("ADMISSION_REPORT_INVALID");
    expect(refusedWith(report(invite(), { providerAgentId: 9101 }))).toBe("ADMISSION_REPORT_INVALID");
    expect(refusedWith(report(invite(), { chainId: String(CHAIN_ID) }))).toBe("ADMISSION_REPORT_INVALID");
    expect(refusedWith(report(invite(), { providerAgentId: "9102" }))).toBe("ADMISSION_REPORT_PROVIDER_MISMATCH");
    expect(refusedWith(report(invite(), { chainId: 8453 }))).toBe("ADMISSION_REPORT_CHAIN_MISMATCH");
    expect(refusedWith(report(null))).toBe("INVITE_MISSING");
    expect(refusedWith(report(invite({ admissionAuthorized: false, authorizedAt: null }))))
      .toBe("INVITE_ADMISSION_NOT_AUTHORIZED");
    expect(refusedWith(report(invite({ admissionAuthorized: "true" })))).toBe("ADMISSION_REPORT_INVALID");
    expect(refusedWith(report(invite({ id: "-leading" })))).toBe("ADMISSION_REPORT_INVALID");
    expect(refusedWith(report(invite({ id: "has space" })))).toBe("ADMISSION_REPORT_INVALID");
    expect(refusedWith(report(invite({ authorizedAt: 5 })))).toBe("ADMISSION_REPORT_INVALID");
    expect(refusedWith(report(invite({ redeemedWallet: AGENT_WALLET })))).toBe("INVITE_WALLET_MISMATCH");
    expect(refusedWith(report(invite({ redeemedWallet: "not a wallet" })))).toBe("INVITE_WALLET_MISMATCH");
    expect(refusedWith(report({ ...invite(), redeemedWallet: undefined }))).toBe("ADMISSION_REPORT_INVALID");
  });
});
