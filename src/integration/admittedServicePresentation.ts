import type { Hex } from "viem";
import type { StandardListing } from "../standardRail/types.js";
import type { MarketplaceChainReader, MarketplaceServiceRecord } from "../marketplace/reader.js";

const DASKI_EXTENSION_URI = "https://daski.xyz/a2a/v1";
// Presentations are re-verified on a short TTL, but a failed refresh must not
// take the public catalog down: the last verified value stays servable for the
// stale window while refreshes keep retrying. Only an authoritative rejection
// (the registry or the provider card no longer matching the admitted listing)
// evicts a stale presentation early.
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_STALE_LIMIT_MS = 24 * 60 * 60_000;

export interface ServicePresentation {
  service: {
    id: Hex;
    slug: string;
    version: string;
    name: string;
    description: string;
    categoryFamily: string;
    serviceType: string;
    jurisdictions: string[];
    turnaroundEstimate: string;
    serviceLifecycle: string;
    agentCardUrl: string;
    providerA2AUrl: string;
  };
  skill: {
    id: string;
    name: string;
    description: string;
    tags: string[];
  };
}

type AgentCardFetch = (listing: StandardListing, serviceUri: string) => Promise<unknown>;

// Raised when an upstream read completed and rejected the listing, as opposed
// to the read itself failing; only these rejections invalidate a stale value.
class AdmittedServiceRejectedError extends Error {}

function rejected(error: unknown): AdmittedServiceRejectedError {
  return new AdmittedServiceRejectedError(
    error instanceof Error ? error.message : "ADMITTED_SERVICE_REJECTED",
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 4_000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function strings(value: unknown, label: string, maximum = 64): string[] {
  if (
    !Array.isArray(value) || value.length > maximum ||
    value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 128)
  ) throw new Error(`${label} is invalid`);
  return value as string[];
}

function httpsUrl(value: unknown, label: string, origin?: string): string {
  const raw = text(value, label, 2_048);
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash ||
    (origin && parsed.origin !== origin)
  ) throw new Error(`${label} is invalid`);
  return parsed.toString();
}

function assertRegistryBinding(
  registered: MarketplaceServiceRecord,
  listing: StandardListing,
): void {
  const commitment = listing.commitment.payload;
  if (
    !registered.active ||
    registered.providerAgentId !== commitment.providerAgentId ||
    registered.serviceId.toLowerCase() !== commitment.serviceId.toLowerCase()
  ) throw new Error("ADMITTED_SERVICE_REGISTRY_MISMATCH");
}

function parsePresentation(
  value: unknown,
  registered: MarketplaceServiceRecord,
  listing: StandardListing,
): ServicePresentation {
  const card = record(value, "provider Agent Card");
  const extensions = record(card.extensions, "provider Agent Card extensions");
  const extension = record(extensions[DASKI_EXTENSION_URI], "Daski Agent Card extension");
  const serviceId = text(extension.onChainServiceId, "Agent Card service id", 66);
  if (
    text(extension.providerAgentId, "Agent Card provider id", 78) !== registered.providerAgentId ||
    serviceId.toLowerCase() !== registered.serviceId.toLowerCase() ||
    text(extension.serviceVersion, "Agent Card service version", 64) !== registered.version
  ) throw new Error("PROVIDER_AGENT_CARD_REGISTRY_MISMATCH");

  if (!Array.isArray(card.skills) || card.skills.length > 128) {
    throw new Error("Provider Agent Card skills are invalid");
  }
  const skillId = listing.offer.payload.skillId;
  const rawSkill = card.skills
    .map((item) => record(item, "provider Agent Card skill"))
    .find((item) => item.id === skillId);
  if (!rawSkill) throw new Error("ADMITTED_SKILL_NOT_PUBLISHED");

  if (!Array.isArray(card.supportedInterfaces) || card.supportedInterfaces.length > 16) {
    throw new Error("Provider Agent Card interfaces are invalid");
  }
  const serviceOrigin = new URL(registered.serviceUri).origin;
  const jsonRpc = card.supportedInterfaces
    .map((item) => record(item, "provider Agent Card interface"))
    .find((item) => item.protocolBinding === "JSONRPC");
  if (!jsonRpc) throw new Error("PROVIDER_A2A_INTERFACE_MISSING");

  return {
    service: {
      id: registered.serviceId,
      slug: text(registered.serviceSlug, "registry service slug", 128),
      version: registered.version,
      name: text(card.name, "provider service name", 160),
      description: text(card.description, "provider service description", 16_000),
      categoryFamily: text(extension.categoryFamily, "provider category family", 128),
      serviceType: text(extension.serviceType, "provider service type", 128),
      jurisdictions: strings(extension.jurisdictions, "provider jurisdictions"),
      turnaroundEstimate: text(extension.turnaroundEstimate, "provider turnaround estimate", 512),
      serviceLifecycle: text(extension.serviceLifecycle, "provider service lifecycle", 128),
      agentCardUrl: httpsUrl(registered.serviceUri, "registry service URI"),
      providerA2AUrl: httpsUrl(jsonRpc.url, "provider A2A URL", serviceOrigin),
    },
    skill: {
      id: text(rawSkill.id, "provider skill id", 128),
      name: text(rawSkill.name, "provider skill name", 160),
      description: text(rawSkill.description, "provider skill description", 32_000),
      tags: strings(rawSkill.tags, "provider skill tags"),
    },
  };
}

interface PresentationCacheEntry {
  freshUntil: number;
  staleUntil: number;
  value: ServicePresentation;
}

export class AdmittedServiceResolver {
  private readonly cache = new Map<string, PresentationCacheEntry>();
  private readonly inFlight = new Map<string, Promise<ServicePresentation>>();

  constructor(
    private readonly reader: MarketplaceChainReader,
    private readonly fetchAgentCard: AgentCardFetch,
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    private readonly staleLimitMs = DEFAULT_STALE_LIMIT_MS,
  ) {}

  async resolve(listing: StandardListing): Promise<ServicePresentation> {
    const cacheKey = this.cacheKey(listing);
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.freshUntil > now) return cached.value;
    const loading = this.startLoad(listing, cacheKey);
    if (cached && cached.staleUntil > now) {
      loading.catch(() => undefined);
      return cached.value;
    }
    return loading;
  }

  // Awaits an actual reload unless the cached value is still fresh, and
  // propagates the failure; resolve() never surfaces one while a stale value
  // is servable, so the background refresh uses this to observe and report it.
  async refresh(listing: StandardListing): Promise<void> {
    const cacheKey = this.cacheKey(listing);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.freshUntil > Date.now()) return;
    await this.startLoad(listing, cacheKey);
  }

  private startLoad(listing: StandardListing, cacheKey: string): Promise<ServicePresentation> {
    const active = this.inFlight.get(cacheKey);
    if (active) return active;
    const loading = this.load(listing)
      .catch((error: unknown) => {
        if (error instanceof AdmittedServiceRejectedError) this.cache.delete(cacheKey);
        throw error;
      })
      .finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, loading);
    return loading;
  }

  private async load(listing: StandardListing): Promise<ServicePresentation> {
    const registered = await this.reader.getService(listing.commitment.payload.serviceId);
    try {
      assertRegistryBinding(registered, listing);
    } catch (error) {
      throw rejected(error);
    }
    const card = await this.fetchAgentCard(listing, registered.serviceUri);
    let presentation: ServicePresentation;
    try {
      presentation = parsePresentation(card, registered, listing);
    } catch (error) {
      throw rejected(error);
    }
    const now = Date.now();
    this.cache.set(this.cacheKey(listing), {
      freshUntil: now + this.cacheTtlMs,
      staleUntil: now + this.staleLimitMs,
      value: presentation,
    });
    return presentation;
  }

  private cacheKey(listing: StandardListing): string {
    return `${listing.commitment.payload.serviceId.toLowerCase()}:${listing.offer.payload.skillId}`;
  }
}
