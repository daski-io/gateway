import { randomUUID } from "node:crypto";
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getCreate2Address,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import type { Config } from "../config.js";
import type { MarketplaceServiceRecord } from "../marketplace/reader.js";
import { canonicalHash } from "../standardRail/canonical.js";
import type { StandardRailConfig } from "../standardRail/config.js";
import { signEnvelope } from "../standardRail/signing.js";
import type {
  GatewaySkillControlProfileV1,
  PreparedListing,
  PreparedServiceRegistration,
  ProviderServiceCard,
  ProviderServiceRegistrationIntentEnvelope,
  PublishedSkillContract,
} from "./types.js";

const splitterFactoryAbi = parseAbi([
  "function deploy(bytes32 salt,uint256 canonicalChainId,address canonicalToken,address providerPayee,address daskiCommissionReceiver,uint16 commissionBps,bytes32 policyVersionHash,bytes32 outcomeIdHash,bytes32 listingCommitmentHash,uint64 listingEpoch) returns (address splitter)",
]);

const splitterConstructorTypes = [
  { type: "uint256" },
  { type: "address" },
  { type: "address" },
  { type: "address" },
  { type: "uint16" },
  { type: "bytes32" },
  { type: "bytes32" },
  { type: "bytes32" },
  { type: "uint64" },
] as const;

export interface DynamicRegistrationPolicy {
  canonicalToken: Address;
  daskiCommissionReceiver: Address;
  commissionBps: number;
  splitterFactory: Address;
  splitterCreationCode: Hex;
  splitterCreationCodeHash: Hex;
  splitterFactoryRuntimeCodeHash: Hex;
  splitterRuntimeCodeHash: Hex;
  policyVersionHash: Hex;
}

export function dynamicRegistrationPolicy(
  config: Pick<Config, "chainId" | "usdc">,
  railConfig: Pick<
    StandardRailConfig,
    "manifest" | "splitterCreationCodeHash" | "splitterFactoryRuntimeCodeHash"
  >,
): DynamicRegistrationPolicy {
  const seed = railConfig.manifest.listings[0];
  if (!seed) throw new Error("Dynamic registration requires an active rail policy seed");
  const commitment = seed.commitment.payload;
  const manifest = seed.manifest.payload;
  for (const listing of railConfig.manifest.listings) {
    if (
      getAddress(listing.commitment.payload.canonicalToken) !==
        getAddress(config.usdc.address) ||
      getAddress(listing.commitment.payload.daskiCommissionReceiver) !==
        getAddress(commitment.daskiCommissionReceiver) ||
      listing.commitment.payload.commissionBps !== commitment.commissionBps ||
      getAddress(listing.commitment.payload.splitterFactory) !==
        getAddress(commitment.splitterFactory)
    ) throw new Error("Active rail listings do not share one dynamic registration policy");
  }
  if (
    manifest.splitterCreationCodeHash.toLowerCase() !==
      railConfig.splitterCreationCodeHash.toLowerCase() ||
    commitment.splitterFactoryRuntimeCodeHash.toLowerCase() !==
      railConfig.splitterFactoryRuntimeCodeHash.toLowerCase()
  ) throw new Error("Dynamic registration splitter policy is not trusted");
  if (keccak256(manifest.splitterCreationCode) !== railConfig.splitterCreationCodeHash) {
    throw new Error("Dynamic registration splitter creation code hash is invalid");
  }
  const policyVersionHash = canonicalHash({
    artifactType: "GatewayDynamicListingPolicyV1",
    chainId: config.chainId,
    canonicalToken: getAddress(config.usdc.address),
    daskiCommissionReceiver: getAddress(commitment.daskiCommissionReceiver),
    commissionBps: commitment.commissionBps,
    splitterFactory: getAddress(commitment.splitterFactory),
    splitterCreationCodeHash: railConfig.splitterCreationCodeHash,
    splitterFactoryRuntimeCodeHash: railConfig.splitterFactoryRuntimeCodeHash,
    chainEvidencePolicyHash: canonicalHash(railConfig.manifest.chainEvidencePolicy),
    railCapabilityRequirementsHash: canonicalHash(
      railConfig.manifest.railCapabilityRequirements,
    ),
  });
  return {
    canonicalToken: getAddress(config.usdc.address),
    daskiCommissionReceiver: getAddress(commitment.daskiCommissionReceiver),
    commissionBps: commitment.commissionBps,
    splitterFactory: getAddress(commitment.splitterFactory),
    splitterCreationCode: manifest.splitterCreationCode,
    splitterCreationCodeHash: railConfig.splitterCreationCodeHash,
    splitterFactoryRuntimeCodeHash: railConfig.splitterFactoryRuntimeCodeHash,
    splitterRuntimeCodeHash: manifest.splitterRuntimeCodeHash,
    policyVersionHash,
  };
}

export function computeServiceId(
  providerAgentId: string,
  serviceSlug: string,
  serviceVersion: string,
): Hex {
  return keccak256(encodeAbiParameters([
    { type: "uint256" }, { type: "string" }, { type: "string" },
  ], [BigInt(providerAgentId), serviceSlug, serviceVersion]));
}

export function computeListingKey(args: {
  chainId: number;
  providerAgentId: string;
  serviceId: Hex;
  skillId: string;
}): Hex {
  return canonicalHash({
    domain: "DaskiListingKeyV1",
    chainId: args.chainId,
    providerAgentId: args.providerAgentId,
    serviceId: args.serviceId.toLowerCase(),
    skillId: args.skillId,
  });
}

function computeSplitter(args: {
  policy: DynamicRegistrationPolicy;
  chainId: number;
  providerPayee: Address;
  listingKey: Hex;
  listingCommitmentHash: Hex;
  listingEpoch: bigint;
  salt: Hex;
}): { address: Address; initCodeHash: Hex } {
  const constructorArgs = encodeAbiParameters(splitterConstructorTypes, [
    BigInt(args.chainId),
    args.policy.canonicalToken,
    args.providerPayee,
    args.policy.daskiCommissionReceiver,
    args.policy.commissionBps,
    args.policy.policyVersionHash,
    args.listingKey,
    args.listingCommitmentHash,
    args.listingEpoch,
  ]);
  const initCodeHash = keccak256(concatHex([
    args.policy.splitterCreationCode,
    constructorArgs,
  ]));
  return {
    initCodeHash,
    address: getCreate2Address({
      from: args.policy.splitterFactory,
      salt: args.salt,
      bytecodeHash: initCodeHash,
    }),
  };
}

async function prepareControlProfile(args: {
  registrationId: string;
  providerAgentId: string;
  providerIntentHash: Hex;
  serviceId: Hex;
  serviceSlug: string;
  skill: PublishedSkillContract;
  endpoint: string;
  policyVersionHash: Hex;
  config: Pick<Config, "chainId" | "publicUrl">;
  railConfig: Pick<StandardRailConfig, "environment" | "dispatchPrivateKey">;
}) {
  const action = args.skill.contract.assetAction;
  if (!action) return null;
  const payload: GatewaySkillControlProfileV1 = {
    registrationId: args.registrationId,
    providerAgentId: args.providerAgentId,
    providerIntentHash: args.providerIntentHash,
    serviceId: args.serviceId,
    serviceSlug: args.serviceSlug,
    skillId: args.skill.skillId,
    skillContractHash: args.skill.skillContractHash,
    policyVersionHash: args.policyVersionHash,
    providerEndpoint: args.endpoint,
    ownershipPolicy: action.ownershipPolicy,
    effect: action.effect,
    replayPolicy: action.replayPolicy,
    retentionSeconds: action.retentionSeconds,
    walletAuthorizationRequired: true,
    delayedConfirmationRequired: action.effect === "destructive",
    confirmationSummarySchemaHash: action.confirmationSummarySchema
      ? canonicalHash(action.confirmationSummarySchema)
      : null,
    confirmationSummaryTemplateHash: action.confirmationSummaryTemplate
      ? canonicalHash(action.confirmationSummaryTemplate)
      : null,
  };
  const now = Math.floor(Date.now() / 1_000);
  return signEnvelope({
    artifactType: "GatewaySkillControlProfileV1",
    environment: args.railConfig.environment,
    chainId: args.config.chainId,
    audience: args.config.publicUrl,
    signerKeyId: "gateway-protocol",
    privateKey: args.railConfig.dispatchPrivateKey,
    issuedAt: now,
    validBefore: now + 315_360_000,
    payload,
  });
}

async function prepareListing(args: {
  registrationId: string;
  providerAgentId: string;
  providerPayee: Address;
  serviceId: Hex;
  card: ProviderServiceCard;
  skill: PublishedSkillContract;
  config: Pick<Config, "chainId" | "publicUrl">;
  railConfig: Pick<StandardRailConfig, "environment" | "dispatchPrivateKey">;
  policy: DynamicRegistrationPolicy;
  providerIntentHash: Hex;
  priorListing?: PreparedListing;
  priorSkill?: PublishedSkillContract;
}): Promise<PreparedListing> {
  const listingKey = computeListingKey({
    chainId: args.config.chainId,
    providerAgentId: args.providerAgentId,
    serviceId: args.serviceId,
    skillId: args.skill.skillId,
  });
  if (
    args.priorListing &&
    args.priorSkill?.skillContractHash === args.skill.skillContractHash &&
    args.priorListing.listingKey === listingKey
  ) {
    return {
      ...args.priorListing,
      skillContractHash: args.skill.skillContractHash,
      acceptingNewOrders: args.skill.acceptingNewOrders,
      deploymentRequired: false,
      reused: true,
      transaction: null,
    };
  }

  const listingId = randomUUID();
  const controlProfile = await prepareControlProfile({
    registrationId: args.registrationId,
    providerAgentId: args.providerAgentId,
    providerIntentHash: args.providerIntentHash,
    serviceId: args.serviceId,
    serviceSlug: args.card.service.slug,
    skill: args.skill,
    endpoint: args.card.standardRail.assetActionUrl,
    policyVersionHash: args.policy.policyVersionHash,
    config: args.config,
    railConfig: args.railConfig,
  });
  // Availability never shapes deployment: every paid skill gets its splitter
  // so the provider can pause and resume through card refresh alone.
  if (!args.skill.contract.paymentRequired) {
    return {
      listingId,
      listingKey,
      skillId: args.skill.skillId,
      skillContractHash: args.skill.skillContractHash,
      paymentRequired: false,
      acceptingNewOrders: args.skill.acceptingNewOrders,
      deploymentRequired: false,
      reused: false,
      splitterAddress: null,
      preparation: null,
      controlProfile,
      transaction: null,
    };
  }

  const priorEpoch = args.priorListing?.preparation
    ? BigInt(args.priorListing.preparation.payload.listingEpoch)
    : 0n;
  const listingEpoch = priorEpoch + 1n;
  const salt = canonicalHash({
    domain: "DaskiDynamicSplitterV1",
    chainId: args.config.chainId,
    registrationId: args.registrationId,
    listingId,
  });
  const payload = {
    registrationId: args.registrationId,
    listingId,
    listingKey,
    providerAgentId: args.providerAgentId,
    serviceId: args.serviceId,
    serviceSlug: args.card.service.slug,
    serviceVersion: args.card.service.version,
    skillId: args.skill.skillId,
    skillContractHash: args.skill.skillContractHash,
    skillContractSetHash: args.card.skillContractSetHash,
    providerIntentHash: args.providerIntentHash,
    canonicalToken: args.policy.canonicalToken,
    providerPayee: args.providerPayee,
    daskiCommissionReceiver: args.policy.daskiCommissionReceiver,
    commissionBps: args.policy.commissionBps,
    splitterFactory: args.policy.splitterFactory,
    splitterDeploymentSalt: salt,
    policyVersionHash: args.policy.policyVersionHash,
    listingEpoch: listingEpoch.toString(),
  };
  const now = Math.floor(Date.now() / 1_000);
  const preparation = await signEnvelope({
    artifactType: "GatewayListingPreparationV1",
    environment: args.railConfig.environment,
    chainId: args.config.chainId,
    audience: args.config.publicUrl,
    signerKeyId: "gateway-protocol",
    privateKey: args.railConfig.dispatchPrivateKey,
    issuedAt: now,
    validBefore: now + 315_360_000,
    payload,
  });
  const listingCommitmentHash = canonicalHash(preparation);
  const splitter = computeSplitter({
    policy: args.policy,
    chainId: args.config.chainId,
    providerPayee: args.providerPayee,
    listingKey,
    listingCommitmentHash,
    listingEpoch,
    salt,
  });
  return {
    listingId,
    listingKey,
    skillId: args.skill.skillId,
    skillContractHash: args.skill.skillContractHash,
    paymentRequired: true,
    acceptingNewOrders: args.skill.acceptingNewOrders,
    deploymentRequired: true,
    reused: false,
    splitterAddress: splitter.address,
    preparation,
    controlProfile,
    transaction: {
      kind: "splitter-deployment",
      listingId,
      to: args.policy.splitterFactory,
      data: encodeFunctionData({
        abi: splitterFactoryAbi,
        functionName: "deploy",
        args: [
          salt, BigInt(args.config.chainId), args.policy.canonicalToken,
          args.providerPayee, args.policy.daskiCommissionReceiver,
          args.policy.commissionBps, args.policy.policyVersionHash,
          listingKey, listingCommitmentHash, listingEpoch,
        ],
      }),
      value: "0",
    },
  };
}

export function listingReuseScopeHash(card: ProviderServiceCard): Hex {
  return canonicalHash({
    schemaVersion: 1,
    providerAgentId: card.providerAgentId,
    service: {
      serviceId: card.service.serviceId,
      slug: card.service.slug,
      version: card.service.version,
      categoryFamily: card.service.categoryFamily,
      serviceType: card.service.serviceType,
      jurisdictions: card.service.jurisdictions,
      lifecycle: card.service.lifecycle,
    },
    standardRail: card.standardRail,
    legal: card.legal,
  });
}

export interface ValidatedServiceRegistration {
  serviceId: Hex;
  providerPayee: Address;
  policy: DynamicRegistrationPolicy;
}

export function validateServiceRegistrationContract(args: {
  intent: ProviderServiceRegistrationIntentEnvelope;
  card: ProviderServiceCard;
  agentWallet: Address;
  service: MarketplaceServiceRecord;
  config: Pick<Config, "chainId" | "usdc">;
  railConfig: StandardRailConfig;
}): ValidatedServiceRegistration {
  const payload = args.intent.payload;
  const serviceId = computeServiceId(
    payload.providerAgentId,
    payload.serviceSlug,
    payload.serviceVersion,
  );
  if (serviceId !== payload.serviceId) {
    throw new Error("provider intent service id is not canonical");
  }
  const policy = dynamicRegistrationPolicy(args.config, args.railConfig);
  if (payload.railPolicyHash !== policy.policyVersionHash) {
    throw new Error("provider intent rail policy is stale");
  }
  const zero = "0x0000000000000000000000000000000000000000";
  const providerPayee = getAddress(
    args.service.serviceWallet.toLowerCase() === zero
      ? args.agentWallet
      : args.service.serviceWallet,
  );
  if (providerPayee !== getAddress(payload.providerPayee)) {
    throw new Error(
      "provider intent payee does not match finalized chain authority",
    );
  }
  const cardSkills = [...args.card.skills]
    .map(({ skillId, skillContractHash }) => ({ skillId, skillContractHash }))
    .sort((left, right) => left.skillId.localeCompare(right.skillId));
  if (
    payload.serviceContractHash !== args.card.serviceContractHash ||
    payload.skillContractSetHash !== args.card.skillContractSetHash ||
    canonicalHash(payload.skills) !== canonicalHash(cardSkills)
  ) {
    throw new Error(
      "provider intent does not bind the complete service and skill contract",
    );
  }
  return { serviceId, providerPayee, policy };
}

export async function prepareServiceRegistration(args: {
  registrationId: string;
  intent: ProviderServiceRegistrationIntentEnvelope;
  card: ProviderServiceCard;
  agentWallet: Address;
  service: MarketplaceServiceRecord;
  config: Pick<Config, "chainId" | "publicUrl" | "usdc">;
  railConfig: StandardRailConfig;
  prior?: {
    card: ProviderServiceCard;
    prepared: PreparedServiceRegistration;
    marketplaceEnabled: boolean;
  } | null;
}): Promise<PreparedServiceRegistration> {
  const payload = args.intent.payload;
  const { serviceId, policy, providerPayee } =
    validateServiceRegistrationContract(args);

  const providerIntentHash = canonicalHash(args.intent);
  const priorUsable =
    args.prior &&
    args.prior.prepared.serviceId === serviceId &&
    getAddress(args.prior.prepared.providerPayee) === providerPayee &&
    args.prior.prepared.railPolicyHash === policy.policyVersionHash &&
    listingReuseScopeHash(args.prior.card) ===
      listingReuseScopeHash(args.card)
      ? args.prior
      : null;
  const priorListings = new Map(
    priorUsable?.prepared.listings.map((listing) => [listing.skillId, listing]) ?? [],
  );
  const priorSkills = new Map(
    priorUsable?.card.skills.map((skill) => [skill.skillId, skill]) ?? [],
  );
  const listings = await Promise.all(args.card.skills.map((skill) =>
    prepareListing({
      registrationId: args.registrationId,
      providerAgentId: payload.providerAgentId,
      providerPayee,
      serviceId,
      card: args.card,
      skill,
      config: args.config,
      railConfig: args.railConfig,
      policy,
      providerIntentHash,
      priorListing: priorListings.get(skill.skillId),
      priorSkill: priorSkills.get(skill.skillId),
    })));
  return {
    registrationId: args.registrationId,
    state: "PREPARED",
    providerAgentId: payload.providerAgentId,
    serviceId,
    serviceSlug: payload.serviceSlug,
    serviceVersion: payload.serviceVersion,
    agentCardUrl: args.service.serviceUri,
    serviceWallet: getAddress(args.service.serviceWallet),
    providerPayee,
    providerIntentHash,
    railPolicyHash: policy.policyVersionHash,
    marketplaceEnabled:
      priorUsable?.marketplaceEnabled ?? args.config.chainId === 84532,
    listings,
  };
}
