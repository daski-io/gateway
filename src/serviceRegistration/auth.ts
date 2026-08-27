import {
  getAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import type { Config } from "../config.js";
import type { MarketplaceChainReader } from "../marketplace/reader.js";
import { artifactPayloadHash } from "../standardRail/canonical.js";
import type { StandardRailConfig } from "../standardRail/config.js";
import type { SignedEnvelope } from "../standardRail/types.js";
import type {
  ProviderServiceRegistrationEvidenceV1,
  ProviderServiceRegistrationEvidenceEnvelope,
  ProviderServiceRegistrationIntentV1,
  ProviderServiceRegistrationIntentEnvelope,
} from "./types.js";

const ENVELOPE_KEYS = [
  "artifactType", "schemaVersion", "environment", "chainId", "audience",
  "signerKeyId", "issuedAt", "validBefore", "payload", "signature",
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const found = record(value, label);
  if (
    Object.keys(found).length !== keys.length ||
    Object.keys(found).some((key) => !keys.includes(key))
  ) throw new Error(`${label} fields are invalid`);
  return found;
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
  return value.toLowerCase() as Hex;
}

function uuid(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) throw new Error(`${label} must be a UUIDv4`);
  return value.toLowerCase();
}

function providerIdentity(value: unknown, expectedAgentId: string): {
  owner: Address;
  agentWallet: Address;
} {
  const provider = record(value, "provider chain record");
  const identity = record(provider.identity, "provider identity");
  if (
    provider.agentId !== expectedAgentId ||
    provider.active !== true
  ) throw new Error("provider is not active on chain");
  try {
    return {
      owner: getAddress(identity.owner as string),
      agentWallet: getAddress(identity.agentWallet as string),
    };
  } catch {
    throw new Error("provider chain authority is invalid");
  }
}

function parseIntent(value: unknown): ProviderServiceRegistrationIntentV1 {
  const payload = exact(value, [
    "providerAgentId", "serviceId", "serviceSlug", "serviceVersion",
    "providerPayee", "serviceContractHash", "skillContractSetHash", "skills", "railPolicyHash",
    "registrationNonce",
  ], "registration intent");
  const serviceSlug = payload.serviceSlug;
  const serviceVersion = payload.serviceVersion;
  if (
    typeof serviceSlug !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(serviceSlug) ||
    typeof serviceVersion !== "string" ||
    serviceVersion.length < 1 || serviceVersion.length > 32 ||
    /[\u0000-\u001f\u007f]/.test(serviceVersion)
  ) throw new Error("service identity is invalid");
  let providerPayee: Address;
  try { providerPayee = getAddress(payload.providerPayee as string); } catch {
    throw new Error("provider payee is invalid");
  }
  if (
    !Array.isArray(payload.skills) || payload.skills.length < 1 ||
    payload.skills.length > 128
  ) throw new Error("intent skill contracts are invalid");
  const skills = payload.skills.map((raw) => {
    const skill = exact(raw, ["skillId", "skillContractHash"], "intent skill");
    if (
      typeof skill.skillId !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,95}$/.test(skill.skillId)
    ) throw new Error("intent skill id is invalid");
    return {
      skillId: skill.skillId,
      skillContractHash: bytes32(skill.skillContractHash, "skill contract hash"),
    };
  });
  if (
    new Set(skills.map((skill) => skill.skillId)).size !== skills.length ||
    skills.some((skill, index) =>
      index > 0 && skills[index - 1]!.skillId.localeCompare(skill.skillId) >= 0)
  ) throw new Error("intent skills must be unique and sorted");
  return {
    providerAgentId: decimal(payload.providerAgentId, "provider agent id"),
    serviceId: bytes32(payload.serviceId, "service id"),
    serviceSlug,
    serviceVersion,
    providerPayee,
    serviceContractHash: bytes32(
      payload.serviceContractHash,
      "service contract hash",
    ),
    skillContractSetHash: bytes32(
      payload.skillContractSetHash,
      "skill contract set hash",
    ),
    skills,
    railPolicyHash: bytes32(payload.railPolicyHash, "rail policy hash"),
    registrationNonce: bytes32(payload.registrationNonce, "registration nonce"),
  };
}

function parseEvidence(value: unknown): ProviderServiceRegistrationEvidenceV1 {
  const payload = exact(value, [
    "registrationId", "preparedRegistrationHash", "expectedState",
    "splitterTransactionHashes", "evidenceNonce",
  ], "registration evidence");
  if (!["PREPARED", "EVIDENCE_PENDING"].includes(payload.expectedState as string)) {
    throw new Error("registration evidence state is invalid");
  }
  if (
    !Array.isArray(payload.splitterTransactionHashes) ||
    payload.splitterTransactionHashes.length > 128
  ) throw new Error("splitter transaction hashes are invalid");
  const splitters = payload.splitterTransactionHashes.map((item) => {
    const entry = exact(item, ["listingId", "transactionHash"], "splitter evidence");
    return {
      listingId: uuid(entry.listingId, "listing id"),
      transactionHash: bytes32(entry.transactionHash, "splitter transaction hash"),
    };
  });
  if (new Set(splitters.map((item) => item.listingId)).size !== splitters.length) {
    throw new Error("splitter evidence listing ids must be unique");
  }
  return {
    registrationId: uuid(payload.registrationId, "registration id"),
    preparedRegistrationHash: bytes32(
      payload.preparedRegistrationHash, "prepared registration hash",
    ),
    expectedState: payload.expectedState as "PREPARED" | "EVIDENCE_PENDING",
    splitterTransactionHashes: splitters,
    evidenceNonce: bytes32(payload.evidenceNonce, "evidence nonce"),
  };
}

async function verifyProviderEnvelope<T>(args: {
  raw: unknown;
  artifactType: string;
  parsePayload: (value: unknown) => T;
  providerAgentId: (payload: T) => string;
  config: Pick<Config, "chainId" | "publicUrl">;
  railConfig: Pick<StandardRailConfig, "environment">;
  marketplace: MarketplaceChainReader;
}): Promise<{
  envelope: SignedEnvelope<T>;
  owner: Address;
  agentWallet: Address;
  signer: Address;
}> {
  const rawEnvelope = exact(args.raw, ENVELOPE_KEYS, "signed registration envelope");
  const envelope = rawEnvelope as unknown as SignedEnvelope<unknown>;
  const now = Math.floor(Date.now() / 1_000);
  if (
    envelope.artifactType !== args.artifactType ||
    envelope.schemaVersion !== 1 ||
    envelope.environment !== args.railConfig.environment ||
    envelope.chainId !== args.config.chainId ||
    envelope.audience !== args.config.publicUrl ||
    envelope.signerKeyId !== "provider-authority" ||
    !Number.isSafeInteger(envelope.issuedAt) ||
    !Number.isSafeInteger(envelope.validBefore) ||
    envelope.issuedAt > now + 30 || envelope.issuedAt < now - 600 ||
    envelope.validBefore <= now ||
    envelope.validBefore > envelope.issuedAt + 600 ||
    typeof envelope.signature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/.test(envelope.signature)
  ) throw new Error("registration envelope domain or validity is invalid");
  const payload = args.parsePayload(envelope.payload);
  const providerAgentId = args.providerAgentId(payload);
  const authority = providerIdentity(
    await args.marketplace.getProvider(BigInt(providerAgentId)),
    providerAgentId,
  );
  let signer: Address;
  try {
    signer = await recoverMessageAddress({
      message: { raw: artifactPayloadHash(envelope as unknown as Record<string, unknown>) },
      signature: envelope.signature,
    });
  } catch {
    throw new Error("registration envelope signature is invalid");
  }
  if (
    getAddress(signer) !== authority.owner &&
    getAddress(signer) !== authority.agentWallet
  ) throw new Error("registration envelope is not signed by current provider authority");
  return {
    envelope: { ...envelope, payload } as SignedEnvelope<T>,
    ...authority,
    signer: getAddress(signer),
  };
}

export function verifyRegistrationIntent(args: {
  raw: unknown;
  config: Pick<Config, "chainId" | "publicUrl">;
  railConfig: Pick<StandardRailConfig, "environment">;
  marketplace: MarketplaceChainReader;
}) {
  return verifyProviderEnvelope({
    ...args,
    artifactType: "ProviderServiceRegistrationIntentV1",
    parsePayload: parseIntent,
    providerAgentId: (payload) => payload.providerAgentId,
  }) as Promise<{
    envelope: ProviderServiceRegistrationIntentEnvelope;
    owner: Address;
    agentWallet: Address;
    signer: Address;
  }>;
}

export function verifyRegistrationEvidence(args: {
  raw: unknown;
  providerAgentId: string;
  config: Pick<Config, "chainId" | "publicUrl">;
  railConfig: Pick<StandardRailConfig, "environment">;
  marketplace: MarketplaceChainReader;
}) {
  return verifyProviderEnvelope({
    ...args,
    artifactType: "ProviderServiceRegistrationEvidenceV1",
    parsePayload: parseEvidence,
    providerAgentId: () => args.providerAgentId,
  }) as Promise<{
    envelope: ProviderServiceRegistrationEvidenceEnvelope;
    owner: Address;
    agentWallet: Address;
    signer: Address;
  }>;
}
