import type { ValidateFunction } from "ajv";
import { getAddress, type Hex } from "viem";
import type { Config } from "../config.js";
import type { SplitterActivationCheckpoint } from "../serviceRegistration/evidence.js";
import type { RuntimeListingCommitmentV1 } from "../serviceRegistration/runtimeCommitment.js";
import type {
  ServiceRegistrationStore,
  StoredRegistration,
} from "../serviceRegistration/store.js";
import type {
  PreparedListing,
  PublishedSkillContract,
} from "../serviceRegistration/types.js";
import { logger } from "../util/logger.js";
import { canonicalHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import { assertListingRoleSeparation } from "./listingRoles.js";
import { assertPassiveProviderOutput } from "./providerOutput.js";
import { DirectReputationReader } from "./reputationReader.js";
import {
  assertSchema,
  compileClosedRequestSchema,
  compileClosedResponseSchema,
} from "./schema.js";
import type {
  CatalogSearchVocabularyV1,
  ProviderControlProfileV1,
  PublicOutcomeDetailV1,
  PublicOutcomeSummaryV1,
  PublicOutcomeV1,
  PublicReputationSummaryV1,
  PublicReputationV1,
  SignedEnvelope,
  StandardListing,
} from "./types.js";

/** §10 commerce fence: a purchase requires provider facts newer than this. */
const PURCHASE_FRESHNESS_SECONDS = 300;
const PUBLIC_CATALOG_LIMIT = 500;

const EMPTY_REPUTATION = {
  transactionCount: "0",
  completedCount: "0",
  failedCount: "0",
  canceledCount: "0",
  completionSampleSize: "0",
  completionRate: null,
  confirmedCount: "0",
  notConfirmedCount: "0",
  confirmationSampleSize: "0",
  buyerSatisfactionRate: null,
  valueWeightedBuyerSatisfactionRate: null,
  totalPaid: "0",
  totalRefunded: "0",
  averageFulfillmentSeconds: null,
  fulfillmentSampleSize: "0",
  recentPurchases: [],
  safeBlock: null,
} satisfies PublicReputationV1;

const SEALED_DEADLINE_POLICY = {
  draftSeconds: 300,
  minimumPaymentWindowSeconds: 30,
  verificationSeconds: 120,
  settlementEvidenceSeconds: 900,
  releaseEvidenceSeconds: 900,
  dispatchSeconds: 300,
  fulfillmentSeconds: 3_600,
} as const;

const SEALED_QUOTE_POLICY = {
  maximumLifetimeSeconds: 180,
  minimumPaymentWindowSeconds: 30,
  personalizedPricing: false,
} as const;

const SEALED_DELIVERY_COMMITMENT = {
  deliveryMode: "asynchronous-v1",
  customerKyc: "provider-post-payment-v1",
  terminalAttestation: "provider-signed-v1",
  responseValidation: "closed-schema-v1",
} as const;

const SEALED_EXTENSION_POLICY = {
  requiredExtensions: [
    "daski-rail-profile",
    "daski-order-terms",
    "daski-order-binding",
  ],
  // The bazaar declaration inlines both outcome schemas and can outgrow the
  // PAYMENT-REQUIRED and PAYMENT-SIGNATURE header transports, so a client
  // paying from the compact challenge header cannot echo it. When echoed it
  // must still match the issued challenge byte for byte.
  optionalExtensions: ["bazaar", "payment-identifier"],
};

const hex32 = /^0x[0-9a-fA-F]{64}$/;
const hex20 = /^0x[0-9a-fA-F]{40}$/;
const unsignedInteger = /^(0|[1-9][0-9]*)$/;

interface ListingRowFacts {
  listingId: string;
  state: string;
  acceptingNewOrders: boolean;
  runtimeCommitmentHash: `0x${string}` | null;
  runtimeCommitment: unknown;
  activationCheckpoint: unknown;
  splitterTransactionHash: `0x${string}` | null;
}

function usdcPricing(
  raw: Record<string, unknown>,
): { mode: "fixed" | "dynamic"; fixedGrossAmount: string } {
  const entry = (raw as Record<string, unknown>)["USDC"];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Listing pricing does not quote USDC");
  }
  const pricing = entry as Record<string, unknown>;
  if (pricing.fixed_amount === undefined) {
    const variable =
      pricing.min_amount !== undefined ||
      pricing.max_amount !== undefined ||
      pricing.price_list !== undefined ||
      pricing.type === "usage";
    if (!variable) throw new Error("Listing pricing admits an unbounded amount");
    return { mode: "dynamic", fixedGrossAmount: "0" };
  }
  if (
    typeof pricing.fixed_amount !== "string" ||
    !/^[1-9][0-9]*$/.test(pricing.fixed_amount)
  ) {
    throw new Error("Listing fixed price is not a positive amount");
  }
  return { mode: "fixed", fixedGrossAmount: pricing.fixed_amount };
}

function checkpointFacts(value: unknown): SplitterActivationCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Listing activation checkpoint is missing");
  }
  const checkpoint = value as Record<string, unknown>;
  const facts = {
    splitterDeploymentTransactionHash: checkpoint.splitterDeploymentTransactionHash,
    splitterDeploymentBlockNumber: checkpoint.splitterDeploymentBlockNumber,
    splitterDeploymentBlockHash: checkpoint.splitterDeploymentBlockHash,
    splitterRuntimeCodeHash: checkpoint.splitterRuntimeCodeHash,
    splitterActivationBlockNumber: checkpoint.splitterActivationBlockNumber,
    splitterActivationBlockHash: checkpoint.splitterActivationBlockHash,
    splitterActivationPosition: checkpoint.splitterActivationPosition,
    splitterStartingTokenBalance: checkpoint.splitterStartingTokenBalance,
    splitterStartingReleaseSequence: checkpoint.splitterStartingReleaseSequence,
  };
  if (
    typeof facts.splitterDeploymentTransactionHash !== "string" ||
    !hex32.test(facts.splitterDeploymentTransactionHash) ||
    typeof facts.splitterDeploymentBlockNumber !== "string" ||
    !unsignedInteger.test(facts.splitterDeploymentBlockNumber) ||
    typeof facts.splitterDeploymentBlockHash !== "string" ||
    !hex32.test(facts.splitterDeploymentBlockHash) ||
    typeof facts.splitterRuntimeCodeHash !== "string" ||
    !hex32.test(facts.splitterRuntimeCodeHash) ||
    typeof facts.splitterActivationBlockNumber !== "string" ||
    !unsignedInteger.test(facts.splitterActivationBlockNumber) ||
    typeof facts.splitterActivationBlockHash !== "string" ||
    !hex32.test(facts.splitterActivationBlockHash) ||
    facts.splitterActivationPosition !== "END_OF_BLOCK" ||
    typeof facts.splitterStartingTokenBalance !== "string" ||
    !unsignedInteger.test(facts.splitterStartingTokenBalance) ||
    typeof facts.splitterStartingReleaseSequence !== "string" ||
    !unsignedInteger.test(facts.splitterStartingReleaseSequence)
  ) {
    throw new Error("Listing activation checkpoint is invalid");
  }
  return facts as SplitterActivationCheckpoint;
}

function resolveDeadlinePolicy(
  raw: Record<string, unknown> | undefined,
): StandardListing["deadlinePolicy"] {
  const policy: Record<string, number> = { ...SEALED_DEADLINE_POLICY };
  for (const key of Object.keys(policy)) {
    const value = raw?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 30) {
      throw new Error("Listing deadline policy override is invalid");
    }
    policy[key] = value as number;
  }
  if (policy.minimumPaymentWindowSeconds! >= policy.draftSeconds!) {
    throw new Error("Listing payment window must precede its draft deadline");
  }
  return policy as unknown as StandardListing["deadlinePolicy"];
}

/**
 * Checkout-time catalog over the service-registration store. Every listing
 * the purchase path sees is assembled here from registration facts — the
 * gateway-signed preparation, the provider-signed intent, the activation
 * checkpoint captured when the splitter deployment was verified, and the
 * provider's current card — with the §10 gates applied: presentation may be
 * up to 24 hours old (enforced by the store's public queries), a purchase
 * requires facts fresher than five minutes and triggers one synchronous
 * card refresh when they are older.
 */
export class StandardRailCatalog {
  private readonly globalArtifacts = new Map<Hex, SignedEnvelope<unknown, number>>();
  private readonly schemaArtifacts = new Map<Hex, Record<string, unknown>>();
  private readonly controlProfiles = new Map<
    string,
    SignedEnvelope<ProviderControlProfileV1>
  >();
  private readonly validators = new Map<
    Hex,
    { request: ValidateFunction; response: ValidateFunction }
  >();

  constructor(
    private readonly railConfig: StandardRailConfig,
    private readonly appConfig: Pick<Config, "chainId" | "publicUrl">,
    private readonly registrations: ServiceRegistrationStore,
    private readonly refreshRegistration: (record: StoredRegistration) => Promise<void>,
    private readonly reputationReader: DirectReputationReader,
  ) {
    for (const artifact of [
      railConfig.manifest.facilitatorProfile,
      railConfig.manifest.railCapabilityRequirements,
      railConfig.manifest.activeRailProfile,
      railConfig.manifest.chainEvidencePolicy,
      ...railConfig.manifest.servicingAdmissions,
      ...railConfig.manifest.actionCatalogs,
      ...railConfig.manifest.providerControlProfiles,
    ]) {
      this.globalArtifacts.set(
        canonicalHash(artifact).toLowerCase() as Hex,
        artifact as SignedEnvelope<unknown, number>,
      );
    }
    for (const profile of railConfig.manifest.providerControlProfiles) {
      this.controlProfiles.set(profile.payload.providerAgentId, profile);
    }
  }

  async publicArtifact(hash: string): Promise<unknown | null> {
    if (!hex32.test(hash)) return null;
    const key = hash.toLowerCase() as Hex;
    const global = this.globalArtifacts.get(key);
    if (global) return global;
    const schema = this.schemaArtifacts.get(key);
    if (schema) return schema;
    const registered = (await this.registrations.getArtifact(key)) as
      | SignedEnvelope<unknown, number>
      | null;
    if (registered) return registered;
    // Rehydrate schema references after a process restart from the current
    // admitted listings before declaring the immutable hash unavailable.
    await this.listOutcomes();
    return this.schemaArtifacts.get(key) ?? null;
  }

  async listing(providerAgentId: string, outcomeId: string): Promise<StandardListing> {
    let record = await this.findCommerceRecord(providerAgentId, outcomeId);
    if (!this.purchaseFresh(record)) {
      await this.refreshRegistration(record).catch(() => undefined);
      record = await this.findCommerceRecord(providerAgentId, outcomeId);
      if (!this.purchaseFresh(record)) throw new Error("OUTCOME_NOT_FOUND");
    }
    return this.assembleListing(
      record,
      ...(await this.listingInputs(record, outcomeId)),
    );
  }

  /** §10 re-fence for an order already in flight: the listing must still be
   *  purchasable and must still resolve to the same admitted version. */
  async verifyListingIdentity(listing: StandardListing): Promise<void> {
    const current = await this.listing(
      listing.commitment.payload.providerAgentId,
      listing.commitment.payload.outcomeId,
    );
    if (current.runtimeCommitmentHash !== listing.runtimeCommitmentHash) {
      throw new Error("LISTING_SUPERSEDED");
    }
  }

  validateRequest(listing: StandardListing, body: unknown): void {
    assertSchema(this.compiled(listing).request, body);
  }

  validateResponse(listing: StandardListing, result: unknown): void {
    assertSchema(this.compiled(listing).response, result, "Response");
    assertPassiveProviderOutput(result);
  }

  async listOutcomes(): Promise<PublicOutcomeV1[]> {
    const rows: PublicOutcomeV1[] = [];
    for (const record of await this.registrations.listPublic(PUBLIC_CATALOG_LIMIT)) {
      for (const listing of await this.assembleServiceSafe(record)) {
        rows.push(this.publicRow(record, listing));
      }
    }
    return rows.sort((left, right) =>
      `${left.providerAgentId}:${left.outcomeId}`.localeCompare(
        `${right.providerAgentId}:${right.outcomeId}`,
      )
    );
  }

  async publicOutcomes(): Promise<PublicOutcomeV1[]> {
    const outcomes = await this.listOutcomes();
    let snapshot;
    try {
      snapshot = await this.reputationReader.forOutcomes(outcomes);
    } catch {
      return outcomes;
    }
    const { providers, services, safeBlock } = snapshot;
    return outcomes.map((outcome): PublicOutcomeV1 => ({
      ...outcome,
      providerReputation: providers.get(String(outcome.providerAgentId)) ??
        { ...outcome.providerReputation, safeBlock },
      serviceReputation: services.get(outcome.serviceId as Hex) ??
        { ...outcome.serviceReputation, safeBlock },
    }));
  }

  async searchOutcomes(filters: {
    text?: string;
    providerAgentId?: string;
    categoryFamily?: string;
    serviceType?: string;
    jurisdiction?: string;
    pricingMode?: "fixed" | "dynamic";
    persistentAsset?: boolean;
    limit: number;
  }): Promise<PublicOutcomeSummaryV1[]> {
    const tokens = (filters.text ?? "").toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 12) ?? [];
    return (await this.publicOutcomes()).filter((outcome) => {
      const service = outcome.service;
      const skill = outcome.skill;
      const haystack = [
        service.name,
        service.description,
        skill.name,
        skill.description,
        ...outcome.tags,
      ].join(" ").toLowerCase().match(/[a-z0-9]+/g) ?? [];
      return (
        tokens.every((token) => haystack.some((word) => word.includes(token))) &&
        (!filters.providerAgentId || outcome.providerAgentId === filters.providerAgentId) &&
        (!filters.categoryFamily || outcome.categoryFamily === filters.categoryFamily) &&
        (!filters.serviceType || outcome.serviceType === filters.serviceType) &&
        (!filters.jurisdiction ||
          jurisdictionMatches(outcome.jurisdictions, filters.jurisdiction)) &&
        (!filters.pricingMode || outcome.pricingMode === filters.pricingMode) &&
        (filters.persistentAsset === undefined ||
          outcome.persistentAsset === filters.persistentAsset)
      );
    }).slice(0, filters.limit).map(summarizeOutcome);
  }

  /** The taxonomy and jurisdiction values present in the live catalog,
   *  served with zero-hit searches so a buyer's next query can use terms
   *  that exist instead of guessing them. */
  async searchVocabulary(): Promise<CatalogSearchVocabularyV1> {
    const outcomes = await this.listOutcomes();
    const distinct = (values: string[]): string[] => [...new Set(values)].sort();
    return {
      note: "text must match every token (substring, no stemming) against " +
        "service/skill names, descriptions, and tags; jurisdiction accepts " +
        "ISO 3166-1 alpha-2 ('US'), ISO 3166-2 ('US-WY'), or 'global', and " +
        "country and subdivision filters match each other's listings.",
      categoryFamilies: distinct(outcomes.map((outcome) => outcome.categoryFamily)),
      serviceTypes: distinct(outcomes.map((outcome) => outcome.serviceType)),
      jurisdictions: distinct(outcomes.flatMap((outcome) => outcome.jurisdictions)),
    };
  }

  async getOutcome(
    providerAgentId: string,
    outcomeId: string,
  ): Promise<PublicOutcomeDetailV1> {
    const outcome = (await this.publicOutcomes()).find((item) =>
      item.providerAgentId === providerAgentId && item.outcomeId === outcomeId
    );
    if (!outcome) throw new Error("OUTCOME_NOT_FOUND");
    const record = await this.findCommerceRecord(providerAgentId, outcomeId);
    const listing = await this.assembleListing(
      record,
      ...(await this.listingInputs(record, outcomeId)),
    );
    return {
      ...outcome,
      requestSchema: listing.requestSchema,
      responseSchema: listing.responseSchema,
      artifacts: {
        runtimeCommitment: listing.runtimeCommitmentHash,
        preparation: listing.manifest.payload.listingCommitmentHash,
        providerIntent: listing.providerIntentHash,
      },
    };
  }

  private async findCommerceRecord(
    providerAgentId: string,
    outcomeId: string,
  ): Promise<StoredRegistration> {
    const matches = (await this.registrations.listActiveByProvider(providerAgentId))
      .filter((record) =>
        this.commerceOpen(record) &&
        record.prepared.listings.some((item) =>
          item.skillId === outcomeId && item.paymentRequired)
      );
    if (matches.length === 0) throw new Error("OUTCOME_NOT_FOUND");
    if (matches.length > 1) throw new Error("OUTCOME_AMBIGUOUS");
    return matches[0]!;
  }

  private commerceOpen(record: StoredRegistration): boolean {
    return (
      record.state === "ACTIVE" &&
      record.marketplaceEnabled &&
      record.cardAcceptingOrders &&
      record.chainActive &&
      record.registrationHealthy &&
      record.lastRefreshedAt !== null
    );
  }

  private purchaseFresh(record: StoredRegistration): boolean {
    return (
      record.lastRefreshedAt !== null &&
      Date.now() - record.lastRefreshedAt.getTime() <=
        PURCHASE_FRESHNESS_SECONDS * 1_000
    );
  }

  private async listingInputs(
    record: StoredRegistration,
    outcomeId: string,
  ): Promise<[PreparedListing, PublishedSkillContract, ListingRowFacts]> {
    const prepared = record.prepared.listings.find((item) =>
      item.skillId === outcomeId && item.paymentRequired);
    if (!prepared) throw new Error("OUTCOME_NOT_FOUND");
    const skill = record.card.skills.find((item) => item.skillId === outcomeId);
    if (!skill) throw new Error("OUTCOME_NOT_FOUND");
    const row = (await this.registrations.listingCommitments([prepared.listingId]))[0];
    if (!row) throw new Error("OUTCOME_NOT_FOUND");
    return [prepared, skill, row];
  }

  private async assembleServiceSafe(
    record: StoredRegistration,
  ): Promise<StandardListing[]> {
    const rows = new Map(
      (await this.registrations.listingCommitments(
        record.prepared.listings.map((item) => item.listingId),
      )).map((row) => [row.listingId, row]),
    );
    const skills = new Map(record.card.skills.map((skill) => [skill.skillId, skill]));
    const listings: StandardListing[] = [];
    for (const prepared of record.prepared.listings) {
      if (!prepared.paymentRequired) continue;
      const skill = skills.get(prepared.skillId);
      const row = rows.get(prepared.listingId);
      if (!skill || !row) continue;
      try {
        listings.push(this.assembleListing(record, prepared, skill, row));
      } catch (error) {
        logger.warn("dynamic listing excluded from the public catalog", {
          registrationId: record.registrationId,
          skillId: prepared.skillId,
          reason: error instanceof Error &&
            /^[A-Za-z0-9 §_-]{1,160}$/.test(error.message)
            ? error.message
            : "UNCLASSIFIED",
        });
      }
    }
    return listings;
  }

  private assembleListing(
    record: StoredRegistration,
    prepared: PreparedListing,
    skill: PublishedSkillContract,
    row: ListingRowFacts,
  ): StandardListing {
    if (!prepared.preparation || !prepared.splitterAddress) {
      throw new Error("Paid listing preparation is incomplete");
    }
    if (row.state !== "ACTIVE" || !row.acceptingNewOrders || !skill.acceptingNewOrders) {
      throw new Error("OUTCOME_NOT_FOUND");
    }
    // §8: presentation refreshes in place, the paid contract may not. A card
    // republishing a changed skill contract closes this listing until the
    // provider registers a matching intent.
    if (skill.skillContractHash !== prepared.skillContractHash) {
      throw new Error("Listing card contract drifted from its admitted version");
    }
    if (!row.runtimeCommitmentHash || !row.runtimeCommitment) {
      throw new Error("Listing runtime commitment is missing");
    }
    const runtime = row.runtimeCommitment as RuntimeListingCommitmentV1;
    if (
      canonicalHash(runtime as unknown as Record<string, unknown>) !==
        row.runtimeCommitmentHash
    ) {
      throw new Error("Listing runtime commitment preimage is corrupt");
    }
    const preparation = prepared.preparation.payload;
    const preparationHash = canonicalHash(prepared.preparation);
    if (
      runtime.preparationHash !== preparationHash ||
      runtime.skillContractHash !== prepared.skillContractHash ||
      runtime.listingKey !== prepared.listingKey ||
      getAddress(runtime.splitterAddress ?? "0x") !== getAddress(prepared.splitterAddress) ||
      getAddress(runtime.providerPayee) !== getAddress(record.providerPayee) ||
      !hex32.test(runtime.providerIntentHash)
    ) {
      throw new Error("Listing runtime commitment conflicts with its registration");
    }
    const checkpoint = checkpointFacts(row.activationCheckpoint);
    const controlProfile = this.controlProfiles.get(record.providerAgentId);
    if (!controlProfile) {
      throw new Error("Provider control profile is not admitted");
    }
    if (
      getAddress(controlProfile.payload.assetResponseKey) !==
        getAddress(record.providerAgentWallet)
    ) {
      throw new Error("Provider control profile key is not the provider wallet");
    }
    assertListingRoleSeparation(
      record.providerAgentWallet as Hex,
      record.providerPayee as Hex,
      preparation.daskiCommissionReceiver,
    );
    const pricing = usdcPricing(skill.contract.pricing);
    if (pricing.mode === "fixed") {
      const bps = BigInt(preparation.commissionBps);
      const minimumReleasableAmount = (10_000n + bps - 1n) / bps;
      if (BigInt(pricing.fixedGrossAmount) < minimumReleasableAmount) {
        throw new Error("Fixed price cannot produce both splitter payment legs");
      }
    }
    const terms = record.card.legal;
    for (const [name, value] of Object.entries(terms)) {
      if (!name.endsWith("Url")) continue;
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) {
        throw new Error("Listing terms URL is invalid");
      }
    }
    const listing: StandardListing = {
      registrationId: record.registrationId,
      listingId: prepared.listingId,
      listingKey: prepared.listingKey,
      runtimeCommitmentHash: row.runtimeCommitmentHash,
      providerIntentHash: runtime.providerIntentHash,
      providerOwner: getAddress(record.providerOwner),
      providerAgentWallet: getAddress(record.providerAgentWallet),
      commitment: {
        payload: {
          canonicalToken: getAddress(preparation.canonicalToken),
          providerAgentId: record.providerAgentId,
          serviceId: record.serviceId,
          providerAuthorityKey: getAddress(record.providerAgentWallet),
          providerTerminalAttestationKey: getAddress(record.providerAgentWallet),
          providerPayee: getAddress(record.providerPayee),
          providerControlProfileHash: canonicalHash(controlProfile),
          outcomeId: skill.skillId,
          absoluteResourceUri:
            `${this.appConfig.publicUrl}/outcomes/${record.providerAgentId}/${skill.skillId}`,
          bindingProfile: "recipe-bound-v2",
          daskiCommissionReceiver: getAddress(preparation.daskiCommissionReceiver),
          commissionBps: preparation.commissionBps,
          listingEpoch: preparation.listingEpoch,
          splitterFactory: getAddress(preparation.splitterFactory),
        },
      },
      manifest: {
        payload: {
          splitterAddress: getAddress(prepared.splitterAddress),
          splitterFactory: getAddress(preparation.splitterFactory),
          splitterDeploymentTransaction: checkpoint.splitterDeploymentTransactionHash,
          splitterDeploymentBlockNumber: checkpoint.splitterDeploymentBlockNumber,
          splitterDeploymentBlockHash: checkpoint.splitterDeploymentBlockHash,
          splitterRuntimeCodeHash: checkpoint.splitterRuntimeCodeHash,
          splitterActivationBlockNumber: checkpoint.splitterActivationBlockNumber,
          splitterActivationBlockHash: checkpoint.splitterActivationBlockHash,
          splitterActivationPosition: "END_OF_BLOCK",
          splitterStartingTokenBalance: checkpoint.splitterStartingTokenBalance,
          splitterStartingReleaseSequence: checkpoint.splitterStartingReleaseSequence,
          outcomeIdHash: prepared.listingKey,
          listingCommitmentHash: preparationHash,
          policyVersionHash: preparation.policyVersionHash,
          listingEpoch: preparation.listingEpoch,
        },
      },
      offer: {
        payload: {
          outcomeId: skill.skillId,
          skillId: skill.skillId,
          providerAgentId: record.providerAgentId,
          providerPayee: getAddress(record.providerPayee),
          pricingMode: pricing.mode,
          fixedGrossAmount: pricing.fixedGrossAmount,
        },
      },
      providerControlProfile: controlProfile,
      discovery: {
        categoryFamily: record.card.service.categoryFamily,
        serviceType: record.card.service.serviceType,
        jurisdictions: record.card.service.jurisdictions,
        tags: skill.presentation.tags,
        persistentAsset: skill.contract.assetType !== null,
      },
      requestSchema: skill.contract.inputSchema,
      responseSchema: skill.contract.resultSchema,
      terms: { ...terms },
      screeningPolicy: {
        policyId: `daski-${this.railConfig.environment}-screening-v1`,
        sanctionsOracle: this.railConfig.screeningPolicy.sanctionsOracle,
        sanctionsOracleRuntimeCodeHash:
          this.railConfig.screeningPolicy.sanctionsOracleRuntimeCodeHash,
        screenPayer: true,
        screenedRoles: [
          "payer",
          "provider-authority",
          "provider-payee",
          "daski-commission-receiver",
          "splitter",
        ],
        providerControlledWallets: [],
      },
      buyerIdentityPolicy: { policyId: "none" },
      extensionPolicy: {
        requiredExtensions: [...SEALED_EXTENSION_POLICY.requiredExtensions],
        optionalExtensions: [...SEALED_EXTENSION_POLICY.optionalExtensions],
      },
      quotePolicy: pricing.mode === "dynamic" ? { ...SEALED_QUOTE_POLICY } : null,
      deliveryCommitment: { ...SEALED_DELIVERY_COMMITMENT },
      capacityPolicy: {
        maxOpenOrders: skill.contract.capacity?.maxOpenOrders ?? 10,
      },
      deadlinePolicy: resolveDeadlinePolicy(skill.contract.deadlines),
    };
    if (
      !hex20.test(listing.commitment.payload.canonicalToken) ||
      listing.deadlinePolicy.dispatchSeconds * 1_000 <
        controlProfile.payload.timeoutMs
    ) {
      throw new Error("Listing dispatch deadline is shorter than the provider timeout");
    }
    // Fail closed before publication: an uncompilable schema is not sellable.
    this.compiled(listing);
    this.schemaArtifacts.set(canonicalHash(listing.requestSchema), listing.requestSchema);
    return listing;
  }

  private compiled(
    listing: StandardListing,
  ): { request: ValidateFunction; response: ValidateFunction } {
    const key = listing.runtimeCommitmentHash;
    const cached = this.validators.get(key);
    if (cached) return cached;
    const compiledPair = {
      request: compileClosedRequestSchema(listing.requestSchema),
      response: compileClosedResponseSchema(listing.responseSchema),
    };
    this.validators.set(key, compiledPair);
    return compiledPair;
  }

  private publicRow(
    record: StoredRegistration,
    listing: StandardListing,
  ): PublicOutcomeV1 {
    const commitment = listing.commitment.payload;
    const skill = record.card.skills.find((item) =>
      item.skillId === listing.offer.payload.skillId)!;
    return {
      providerAgentId: commitment.providerAgentId,
      serviceId: commitment.serviceId,
      outcomeId: commitment.outcomeId,
      skillId: listing.offer.payload.skillId,
      ...listing.discovery,
      bindingProfile: commitment.bindingProfile,
      pricingMode: listing.offer.payload.pricingMode,
      fixedGrossAmount: listing.offer.payload.fixedGrossAmount,
      token: commitment.canonicalToken,
      payTo: listing.manifest.payload.splitterAddress,
      splitterDeploymentBlockNumber:
        listing.manifest.payload.splitterDeploymentBlockNumber,
      providerPayee: commitment.providerPayee,
      daskiCommissionReceiver: commitment.daskiCommissionReceiver,
      commissionBps: commitment.commissionBps,
      providerAudience: listing.providerControlProfile.payload.providerAudience,
      absoluteResourceUri: commitment.absoluteResourceUri,
      listingManifestHash: listing.runtimeCommitmentHash,
      providerOfferHash: listing.providerIntentHash,
      runtimeCommitmentHash: listing.runtimeCommitmentHash,
      providerIntentHash: listing.providerIntentHash,
      splitter: { ...listing.manifest.payload },
      terms: listing.terms,
      deadlinePolicy: listing.deadlinePolicy,
      capacityPolicy: listing.capacityPolicy,
      service: {
        id: record.serviceId,
        slug: record.card.service.slug,
        version: record.card.service.version,
        name: record.card.name,
        description: record.card.description,
        categoryFamily: record.card.service.categoryFamily,
        serviceType: record.card.service.serviceType,
        jurisdictions: record.card.service.jurisdictions,
        turnaroundEstimate: record.card.service.turnaroundEstimate,
        serviceLifecycle: record.card.service.lifecycle,
        agentCardUrl: record.agentCardUrl,
        providerA2AUrl: record.card.standardRail.origin,
      },
      skill: {
        id: skill.skillId,
        name: skill.presentation.name,
        description: skill.presentation.description,
        tags: skill.presentation.tags,
      },
      providerReputation: EMPTY_REPUTATION,
      serviceReputation: EMPTY_REPUTATION,
    };
  }
}

/** ISO 3166-aware jurisdiction match: a `global` listing serves every
 *  filter, a subdivision filter (`US-WY`) is served by its country's
 *  listing (`US`), and a country filter is served by that country's
 *  subdivision listings. */
function jurisdictionMatches(listed: string[], filter: string): boolean {
  const wanted = filter.toUpperCase();
  return listed.some((value) => {
    if (value === "global") return true;
    const have = value.toUpperCase();
    return have === wanted ||
      wanted.startsWith(`${have}-`) ||
      have.startsWith(`${wanted}-`);
  });
}

function reputationHeadline(
  reputation: PublicReputationV1,
): PublicReputationSummaryV1 {
  const { recentPurchases, ...headline } = reputation;
  void recentPurchases;
  return headline;
}

/** Search rows are shortlisting data. The splitter provenance, deadline
 *  and capacity policies, schemas, and purchase history stay behind
 *  `daski_get_outcome`, which serves the full detail row. */
function summarizeOutcome(outcome: PublicOutcomeV1): PublicOutcomeSummaryV1 {
  return {
    providerAgentId: outcome.providerAgentId,
    serviceId: outcome.serviceId,
    outcomeId: outcome.outcomeId,
    skillId: outcome.skillId,
    categoryFamily: outcome.categoryFamily,
    serviceType: outcome.serviceType,
    jurisdictions: outcome.jurisdictions,
    tags: outcome.tags,
    persistentAsset: outcome.persistentAsset,
    pricingMode: outcome.pricingMode,
    fixedGrossAmount: outcome.fixedGrossAmount,
    token: outcome.token,
    providerAudience: outcome.providerAudience,
    absoluteResourceUri: outcome.absoluteResourceUri,
    terms: outcome.terms,
    service: outcome.service,
    skill: outcome.skill,
    providerReputation: reputationHeadline(outcome.providerReputation),
    serviceReputation: reputationHeadline(outcome.serviceReputation),
  };
}
