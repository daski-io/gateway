import type { ValidateFunction } from "ajv";
import type { Hex } from "viem";
import type { MarketplaceChainReader } from "../marketplace/reader.js";
import {
  AdmittedServiceResolver,
  type ServicePresentation,
} from "../integration/admittedServicePresentation.js";
import { logger } from "../util/logger.js";
import { canonicalHash, providerIdentitySnapshotHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardChainEvidence } from "./evidence.js";
import { assertPassiveProviderOutput } from "./providerOutput.js";
import { DirectReputationReader } from "./reputationReader.js";
import {
  assertSchema,
  compileClosedRequestSchema,
  compileClosedResponseSchema,
} from "./schema.js";
import type { SignedEnvelope, StandardListing } from "./types.js";

const PRESENTATION_REFRESH_INTERVAL_MS = 4 * 60_000;

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
};

export class StandardRailCatalog {
  private readonly listings = new Map<string, StandardListing>();
  private readonly requestValidators = new Map<string, ValidateFunction>();
  private readonly responseValidators = new Map<string, ValidateFunction>();
  private readonly publicArtifacts = new Map<Hex, SignedEnvelope<unknown, number>>();
  private readonly resolver: AdmittedServiceResolver;
  private presentationInterval: NodeJS.Timeout | null = null;
  private presentationRefresh: Promise<void> | null = null;

  constructor(
    private readonly config: StandardRailConfig,
    private readonly chainId: number,
    private readonly evidence: StandardChainEvidence,
    marketplace: MarketplaceChainReader,
    private readonly reputationReader: DirectReputationReader,
    fetchAgentCard: (listing: StandardListing, endpoint: string) => Promise<unknown>,
  ) {
    this.resolver = new AdmittedServiceResolver(marketplace, fetchAgentCard);
    for (const artifact of [
      config.manifest.facilitatorProfile,
      config.manifest.railCapabilityRequirements,
      config.manifest.activeRailProfile,
      config.manifest.chainEvidencePolicy,
      ...config.manifest.providerIdentitySnapshots,
      ...config.manifest.servicingAdmissions,
      ...config.manifest.actionCatalogs,
      ...config.manifest.listings.flatMap((listing) => [
        listing.commitment,
        listing.manifest,
        listing.offer,
        listing.providerControlProfile,
      ]),
    ]) {
      this.publicArtifacts.set(
        canonicalHash(artifact),
        artifact as SignedEnvelope<unknown, number>,
      );
    }
    for (const listing of config.manifest.listings) {
      const payload = listing.commitment.payload;
      const key = `${payload.providerAgentId}:${payload.outcomeId}`;
      this.listings.set(key, listing);
      this.requestValidators.set(key, compileClosedRequestSchema(listing.requestSchema));
      this.responseValidators.set(key, compileClosedResponseSchema(listing.responseSchema));
    }
  }

  start(): void {
    void this.refreshPresentations();
    this.presentationInterval = setInterval(() => {
      void this.refreshPresentations();
    }, PRESENTATION_REFRESH_INTERVAL_MS);
    this.presentationInterval.unref();
  }

  async stop(): Promise<void> {
    if (this.presentationInterval) clearInterval(this.presentationInterval);
    this.presentationInterval = null;
    await this.presentationRefresh?.catch(() => undefined);
  }

  publicArtifact(hash: string): SignedEnvelope<unknown, number> | null {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
    return this.publicArtifacts.get(hash.toLowerCase() as Hex) ?? null;
  }

  listing(providerAgentId: string, outcomeId: string): StandardListing {
    const listing = this.listings.get(`${providerAgentId}:${outcomeId}`);
    if (!listing) throw new Error("OUTCOME_NOT_FOUND");
    return listing;
  }

  async verifyListingIdentity(listing: StandardListing): Promise<void> {
    const snapshot = this.config.manifest.providerIdentitySnapshots.find((item) =>
      providerIdentitySnapshotHash(item.payload, this.chainId) ===
        listing.commitment.payload.providerIdentitySnapshotHash
    );
    if (!snapshot) throw new Error("LISTING_IDENTITY_SNAPSHOT_UNAVAILABLE");
    await this.evidence.revalidateProviderIdentitySnapshot(snapshot.payload);
  }

  validateRequest(listing: StandardListing, body: unknown): void {
    const payload = listing.commitment.payload;
    const validate = this.requestValidators.get(
      `${payload.providerAgentId}:${payload.outcomeId}`,
    );
    if (!validate) throw new Error("Outcome request validator is unavailable");
    assertSchema(validate, body);
  }

  validateResponse(listing: StandardListing, result: unknown): void {
    const payload = listing.commitment.payload;
    const validate = this.responseValidators.get(
      `${payload.providerAgentId}:${payload.outcomeId}`,
    );
    if (!validate) throw new Error("Outcome response validator is unavailable");
    assertSchema(validate, result, "Response");
    assertPassiveProviderOutput(result);
  }

  listOutcomes(): Array<Record<string, unknown>> {
    return [...this.listings.values()].map((listing) => ({
      providerAgentId: listing.commitment.payload.providerAgentId,
      serviceId: listing.commitment.payload.serviceId,
      outcomeId: listing.commitment.payload.outcomeId,
      skillId: listing.offer.payload.skillId,
      ...listing.discovery,
      bindingProfile: listing.commitment.payload.bindingProfile,
      pricingMode: listing.offer.payload.pricingMode,
      fixedGrossAmount: listing.offer.payload.fixedGrossAmount,
      token: listing.commitment.payload.canonicalToken,
      payTo: listing.manifest.payload.splitterAddress,
      splitterDeploymentBlockNumber: listing.manifest.payload.splitterDeploymentBlockNumber,
      providerPayee: listing.commitment.payload.providerPayee,
      daskiCommissionReceiver: listing.commitment.payload.daskiCommissionReceiver,
      commissionBps: listing.commitment.payload.commissionBps,
      providerAudience: listing.providerControlProfile.payload.providerAudience,
      absoluteResourceUri: listing.commitment.payload.absoluteResourceUri,
      listingManifestHash: canonicalHash(listing.manifest),
      providerOfferHash: canonicalHash(listing.offer),
      terms: listing.terms,
      deadlinePolicy: listing.deadlinePolicy,
      capacityPolicy: listing.capacityPolicy,
      providerReputation: EMPTY_REPUTATION,
      serviceReputation: EMPTY_REPUTATION,
      reputation: EMPTY_REPUTATION,
    }));
  }

  async publicOutcomes(): Promise<Array<Record<string, unknown>>> {
    const outcomes: Array<Record<string, unknown>> = (await Promise.all(
      this.listOutcomes().map(async (outcome): Promise<Record<string, unknown> | null> => {
        const listing = this.listing(
          String(outcome.providerAgentId),
          String(outcome.outcomeId),
        );
        try {
          return { ...outcome, ...await this.resolver.resolve(listing) };
        } catch {
          return null;
        }
      }),
    )).filter((outcome): outcome is Record<string, unknown> => outcome !== null);
    let snapshot;
    try {
      snapshot = await this.reputationReader.forOutcomes(outcomes);
    } catch {
      return outcomes;
    }
    const { providers, services, safeBlock } = snapshot;
    return outcomes.map((outcome) => ({
      ...outcome,
      providerReputation: providers.get(String(outcome.providerAgentId)) ??
        { ...(outcome.providerReputation as object), safeBlock },
      serviceReputation: services.get(outcome.serviceId as Hex) ??
        { ...(outcome.serviceReputation as object), safeBlock },
      reputation: services.get(outcome.serviceId as Hex) ??
        { ...(outcome.reputation as object), safeBlock },
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
  }): Promise<Array<Record<string, unknown>>> {
    const tokens = (filters.text ?? "").toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 12) ?? [];
    return (await this.publicOutcomes()).filter((outcome) => {
      const row = outcome as Record<string, unknown>;
      const presentation = row as unknown as ServicePresentation;
      const haystack = [
        presentation.service.name,
        presentation.service.description,
        presentation.skill.name,
        presentation.skill.description,
        ...(row.tags as string[]),
      ].join(" ").toLowerCase().match(/[a-z0-9]+/g) ?? [];
      return (
        tokens.every((token) => haystack.some((word) => word.includes(token))) &&
        (!filters.providerAgentId || row.providerAgentId === filters.providerAgentId) &&
        (!filters.categoryFamily || row.categoryFamily === filters.categoryFamily) &&
        (!filters.serviceType || row.serviceType === filters.serviceType) &&
        (!filters.jurisdiction ||
          (row.jurisdictions as string[]).includes(filters.jurisdiction)) &&
        (!filters.pricingMode || row.pricingMode === filters.pricingMode) &&
        (filters.persistentAsset === undefined ||
          row.persistentAsset === filters.persistentAsset)
      );
    }).sort((left, right) =>
      `${left.providerAgentId}:${left.outcomeId}`.localeCompare(
        `${right.providerAgentId}:${right.outcomeId}`,
      )
    ).slice(0, filters.limit);
  }

  async getOutcome(
    providerAgentId: string,
    outcomeId: string,
  ): Promise<Record<string, unknown>> {
    const outcome = (await this.publicOutcomes()).find((item) =>
      item.providerAgentId === providerAgentId && item.outcomeId === outcomeId
    );
    if (!outcome) throw new Error("OUTCOME_NOT_FOUND");
    const listing = this.listing(providerAgentId, outcomeId);
    return {
      ...outcome,
      requestSchema: listing.requestSchema,
      responseSchema: listing.responseSchema,
      artifacts: {
        commitment: canonicalHash(listing.commitment),
        manifest: canonicalHash(listing.manifest),
        offer: canonicalHash(listing.offer),
      },
    };
  }

  private refreshPresentations(): Promise<void> {
    this.presentationRefresh ??= (async () => {
      try {
        for (const listing of this.listings.values()) {
          try {
            await this.resolver.refresh(listing);
          } catch (error) {
            const payload = listing.commitment.payload;
            logger.warn("standard service presentation refresh failed", {
              providerAgentId: payload.providerAgentId,
              outcomeId: payload.outcomeId,
              reason: error instanceof Error &&
                /^[A-Za-z0-9 _-]{1,120}$/.test(error.message)
                ? error.message
                : "UNCLASSIFIED",
              error,
            });
          }
        }
      } finally {
        this.presentationRefresh = null;
      }
    })();
    return this.presentationRefresh;
  }
}
