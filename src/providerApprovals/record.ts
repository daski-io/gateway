import { getAddress, type Hex } from "viem";
import type { ProviderServiceCard } from "../serviceRegistration/types.js";
import { assertProviderControlProfilePayload } from "../standardRail/artifacts.js";
import { canonicalHash } from "../standardRail/canonical.js";
import type { ProviderControlProfileV1, SignedEnvelope } from "../standardRail/types.js";

/// A provider approval record: the ProviderControlProfileV1 envelope the
/// gateway builds for a hosted provider it approved (docs/provider-approvals.md).
/// It is built once, from the provider's active registration and the
/// standard-rail block of its stored card, and stored; it is never signed.
/// Its fixed envelope fields mark it as a gateway approval, and its payload
/// passes the same rules the start-up check applies to a manifest profile.

/** The signer key id of every approval record; no key is behind it. */
export const PROVIDER_APPROVAL_SIGNER_KEY_ID = "gateway-approval-v1";

/**
 * The payload fields every approval record carries unchanged. A hosted
 * provider runtime expects the same response bound and timeout of a seller's
 * profile (its HOSTED_PROFILE_MAX_RESPONSE_BYTES and HOSTED_PROFILE_TIMEOUT_MS,
 * 524,288 and 90,000 by default): change them together.
 */
export const PROVIDER_APPROVAL_CONSTANTS = {
  assetResponseKeyId: "provider-wallet",
  tlsPolicy: "webpki-v1",
  workloadAuthentication: "signed-envelopes-v1",
  maxResponseBytes: 524_288,
  timeoutMs: 90_000,
} as const;

export type ProviderApprovalRecord = SignedEnvelope<ProviderControlProfileV1>;

/** Why the gateway refused to approve a provider; `code` is safe to log and answer. */
export class ProviderApprovalRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The envelope domain a manifest profile carries for this gateway. */
export interface ProviderApprovalDomain {
  environment: string;
  chainId: number;
  gatewayAudience: string;
}

/** The registration facts a record is built from. */
export interface ProviderApprovalSource {
  providerAgentId: string;
  providerAgentWallet: string;
  card: Pick<ProviderServiceCard, "providerAgentId" | "standardRail">;
}

const CARD_TEXTS = [
  "providerAudience", "origin", "quoteUrl", "dispatchUrl", "dispatchStatusUrl",
  "lifecycleUrl", "assetQueryUrl", "assetActionUrl",
] as const;

/**
 * One more than the highest servicing profile epoch any manifest profile of
 * the provider carries, else 1. A record's epoch is also above every earlier
 * approval record of the provider (the store passes that as `minimumEpoch`).
 */
export function approvalProfileEpoch(
  providerAgentId: string,
  manifestProfiles: readonly SignedEnvelope<ProviderControlProfileV1>[],
): number {
  const epochs = manifestProfiles
    .filter((profile) => profile.payload.providerAgentId === providerAgentId)
    .map((profile) => profile.payload.servicingProfileEpoch);
  return epochs.length === 0 ? 1 : Math.max(...epochs) + 1;
}

/**
 * Builds the approval record of a provider from its registration. The texts
 * are the card's standard-rail values as stored, verbatim; the response key is
 * the registration's agent wallet, checksummed. The epoch is one more than the
 * provider's highest manifest profile epoch, and at least `minimumEpoch`.
 * Refuses a registration whose texts would not pass the start-up check's rules
 * for a control profile.
 */
export function buildProviderApprovalRecord(args: {
  domain: ProviderApprovalDomain;
  registration: ProviderApprovalSource;
  manifestProfiles: readonly SignedEnvelope<ProviderControlProfileV1>[];
  minimumEpoch?: number;
}): { record: ProviderApprovalRecord; recordHash: Hex } {
  const { registration } = args;
  const minimumEpoch = args.minimumEpoch ?? 1;
  if (!Number.isSafeInteger(minimumEpoch) || minimumEpoch < 1) {
    throw new ProviderApprovalRefused("PROVIDER_APPROVAL_EPOCH_INVALID");
  }
  if (
    !/^[1-9][0-9]{0,77}$/.test(registration.providerAgentId) ||
    registration.card.providerAgentId !== registration.providerAgentId
  ) throw new ProviderApprovalRefused("PROVIDER_APPROVAL_IDENTITY_INVALID");
  const rail = registration.card.standardRail as unknown as Record<string, unknown> | undefined;
  if (!rail || CARD_TEXTS.some((name) => typeof rail[name] !== "string")) {
    throw new ProviderApprovalRefused("PROVIDER_APPROVAL_PROFILE_INVALID");
  }
  let assetResponseKey: Hex;
  try {
    assetResponseKey = getAddress(registration.providerAgentWallet);
  } catch {
    throw new ProviderApprovalRefused("PROVIDER_APPROVAL_WALLET_INVALID");
  }
  const text = (name: typeof CARD_TEXTS[number]) => rail[name] as string;
  const payload: ProviderControlProfileV1 = {
    providerAgentId: registration.providerAgentId,
    providerAudience: text("providerAudience"),
    origin: text("origin"),
    quoteUrl: text("quoteUrl"),
    dispatchUrl: text("dispatchUrl"),
    dispatchStatusUrl: text("dispatchStatusUrl"),
    lifecycleUrl: text("lifecycleUrl"),
    assetQueryUrl: text("assetQueryUrl"),
    assetActionUrl: text("assetActionUrl"),
    assetResponseKeyId: PROVIDER_APPROVAL_CONSTANTS.assetResponseKeyId,
    assetResponseKey,
    servicingProfileEpoch: Math.max(approvalProfileEpoch(registration.providerAgentId, args.manifestProfiles), minimumEpoch),
    tlsPolicy: PROVIDER_APPROVAL_CONSTANTS.tlsPolicy,
    workloadAuthentication: PROVIDER_APPROVAL_CONSTANTS.workloadAuthentication,
    maxResponseBytes: PROVIDER_APPROVAL_CONSTANTS.maxResponseBytes,
    timeoutMs: PROVIDER_APPROVAL_CONSTANTS.timeoutMs,
  };
  try {
    assertProviderControlProfilePayload(payload);
  } catch {
    throw new ProviderApprovalRefused("PROVIDER_APPROVAL_PROFILE_INVALID");
  }
  const record: ProviderApprovalRecord = {
    artifactType: "ProviderControlProfileV1",
    schemaVersion: 1,
    environment: args.domain.environment,
    chainId: args.domain.chainId,
    audience: args.domain.gatewayAudience,
    signerKeyId: PROVIDER_APPROVAL_SIGNER_KEY_ID,
    issuedAt: 0,
    validBefore: 0,
    payload,
    signature: "0x",
  };
  return { record, recordHash: canonicalHash(record) };
}

/** The endpoint paths below a seller's base, as a hosted provider runtime builds them. */
export const HOSTED_ENDPOINT_PATHS = {
  quoteUrl: "/standard-rail/quote",
  dispatchUrl: "/standard-rail/dispatch",
  dispatchStatusUrl: "/standard-rail/dispatch/status",
  lifecycleUrl: "/standard-rail/lifecycle",
  assetQueryUrl: "/standard-rail/assets/query",
  assetActionUrl: "/standard-rail/assets/action",
} as const;

/**
 * Refuses a record whose texts are not exactly those a hosted provider
 * runtime builds for the seller: the bare origin, the origin with a slash as
 * audience, and every URL at `<origin>/p/<agent id>` plus its fixed path.
 */
export function assertHostedLayout(record: ProviderApprovalRecord): void {
  const { origin, providerAgentId } = record.payload;
  let bare: string;
  try { bare = new URL(origin).origin; } catch { throw new ProviderApprovalRefused("PROVIDER_APPROVAL_NOT_HOSTED_LAYOUT"); }
  const base = `${bare}/p/${providerAgentId}`;
  if (
    origin !== bare || record.payload.providerAudience !== `${bare}/` ||
    Object.entries(HOSTED_ENDPOINT_PATHS).some(([name, path]) =>
      record.payload[name as keyof typeof HOSTED_ENDPOINT_PATHS] !== `${base}${path}`)
  ) throw new ProviderApprovalRefused("PROVIDER_APPROVAL_NOT_HOSTED_LAYOUT");
}

/** Whether two records differ in their response key and in nothing else. */
export function differsOnlyInResponseKey(left: ProviderApprovalRecord, right: ProviderApprovalRecord): boolean {
  return left.payload.assetResponseKey !== right.payload.assetResponseKey &&
    canonicalHash({ ...left, payload: { ...left.payload, assetResponseKey: right.payload.assetResponseKey } }) ===
      canonicalHash(right);
}

/** What an accepted invite admission report contributes to the approval. */
export interface AcceptedInviteAdmission {
  inviteId: string;
}

/**
 * Accepts a hosted runtime's invite admission report for one provider:
 * `{ providerAgentId, chainId, invite: { id, admissionAuthorized,
 * authorizedAt, redeemedWallet } }`, naming this provider and chain, with the
 * invite's admission authorized and redeemed by the registration's owner.
 * Fields beyond these are ignored.
 */
export function acceptInviteAdmission(
  raw: unknown,
  expected: { providerAgentId: string; chainId: number; providerOwner: string },
): AcceptedInviteAdmission {
  const object = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const report = object(raw);
  if (!report || typeof report.providerAgentId !== "string" || !Number.isSafeInteger(report.chainId)) {
    throw new ProviderApprovalRefused("ADMISSION_REPORT_INVALID");
  }
  if (report.providerAgentId !== expected.providerAgentId) {
    throw new ProviderApprovalRefused("ADMISSION_REPORT_PROVIDER_MISMATCH");
  }
  if (report.chainId !== expected.chainId) throw new ProviderApprovalRefused("ADMISSION_REPORT_CHAIN_MISMATCH");
  if (report.invite === null) throw new ProviderApprovalRefused("INVITE_MISSING");
  const invite = object(report.invite);
  if (
    !invite || typeof invite.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(invite.id) ||
    typeof invite.admissionAuthorized !== "boolean" ||
    (invite.authorizedAt !== null && typeof invite.authorizedAt !== "string") ||
    typeof invite.redeemedWallet !== "string"
  ) throw new ProviderApprovalRefused("ADMISSION_REPORT_INVALID");
  if (invite.admissionAuthorized !== true) throw new ProviderApprovalRefused("INVITE_ADMISSION_NOT_AUTHORIZED");
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(invite.redeemedWallet) ||
    invite.redeemedWallet.toLowerCase() !== expected.providerOwner.toLowerCase()
  ) throw new ProviderApprovalRefused("INVITE_WALLET_MISMATCH");
  return { inviteId: invite.id };
}
