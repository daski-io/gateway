import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import {
  extractAgentCardName,
  extractAgentCardUrl,
  extractMarketplaceExtension,
} from "../discovery/format.js";
import type { CachedProvider, Hex, StoredChallenge } from "../types.js";

/**
 * Curated, UI-friendly view of a service offered by one provider. This is
 * the wire shape served by /public/v1/services — distinct from the discovery
 * `/discover` shape (which dumps the raw Agent Card and is consumed by
 * agents) because the marketing site needs a flat, predictable schema with
 * human-readable prices, not raw atomic units.
 */
export interface PublicService {
  agentId: string;
  name: string;
  providerAddress: Hex;
  agentURI: string;
  category: string | null;
  serviceDescription: string | null;
  serviceLifecycle: string | null;
  turnaroundEstimate: string | null;
  providerA2AUrl: string | null;
  pricing: PublicServicePricing;
  skills: PublicSkill[];
}

export interface PublicServicePricing {
  currency: string | null;
  /** USDC, two-decimal string. Null when the service uses live pricing. */
  basePrice: string | null;
  /** Live-pricing model identifier (e.g. "live") when set, else null. */
  pricingModel: string | null;
  variable: boolean;
  billingModel: string | null;
}

export interface PublicSkillPricingModel {
  /** "live" for registrar/quote-driven skills; reserved for future kinds. */
  kind: string;
  /** Where the live quote comes from (e.g. "registrar"). */
  source: string | null;
  /** Human-readable hint shown to integrators / on the website. */
  hint: string | null;
}

export interface PublicSkill {
  id: string;
  name: string;
  description: string | null;
  /** USDC, two-decimal string. Null when the skill uses live pricing. */
  basePrice: string | null;
  /**
   * Legacy field — kept for back-compat. New consumers should read
   * `pricingModelDetail` for the structured form.
   */
  pricingModel: string | null;
  pricingModelDetail: PublicSkillPricingModel | null;
  variable: boolean;
  paymentRequired: boolean;
  /** Asset/capability shape — needed by integrators to know what to send. */
  requiredFields: string[] | null;
  requiresAssetOwnership: boolean;
  requiresCapability: boolean;
  assetType: string | null;
}

export interface PublicActivityRow {
  /** Always set — only paid rows are emitted. */
  txHash: Hex;
  buyerAgentId: string;
  providerAgentId: string;
  /** Resolved from the discovery cache; null if the provider has been
   *  deregistered or removed from the whitelist since this row landed. */
  providerName: string | null;
  /** USDC, two-decimal string. */
  amount: string;
  skillId: string | null;
  /** ISO-8601 timestamp of on-chain settlement (verified_at). */
  timestamp: string;
}

function atomicToUsdc(atomic: string | number | bigint): string {
  return (Number(atomic) / 1_000_000).toFixed(2);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBoolean(v: unknown): boolean {
  return v === true;
}

interface RawSkill {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  metadata?: unknown;
}

/**
 * Pulls per-skill metadata using the same dual-shape strategy as
 * `discovery/format.ts:extractSkills`:
 *   A) skill.metadata[DASKI_A2A_EXTENSION_URI]
 *   B) extension.skills[skillId]
 * Skills present in the card but with no metadata are still emitted so the
 * UI can show their existence.
 */
function flattenSkills(agentCard: Record<string, unknown>): PublicSkill[] {
  const skills = agentCard["skills"];
  if (!Array.isArray(skills)) return [];

  const ext = extractMarketplaceExtension(agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;
  const shapeBMap =
    ext?.skills && typeof ext.skills === "object" && !Array.isArray(ext.skills)
      ? (ext.skills as Record<string, unknown>)
      : null;

  // Avoid hardcoding the extension URI here — the discovery formatter
  // imports it; we walk skill.metadata at runtime to find any object-typed
  // entry that looks like marketplace metadata.
  const out: PublicSkill[] = [];
  for (const raw of skills as RawSkill[]) {
    if (!raw || typeof raw !== "object") continue;
    const id = asString(raw.id);
    if (!id) continue;

    let meta: Record<string, unknown> = {};
    if (raw.metadata && typeof raw.metadata === "object") {
      const shapeA = (raw.metadata as Record<string, unknown>)[
        DASKI_A2A_EXTENSION_URI
      ];
      if (shapeA && typeof shapeA === "object") {
        meta = shapeA as Record<string, unknown>;
      }
    }
    if (Object.keys(meta).length === 0 && shapeBMap) {
      const shapeB = shapeBMap[id];
      if (shapeB && typeof shapeB === "object") {
        meta = shapeB as Record<string, unknown>;
      }
    }

    const baseAmount = meta.baseAmount;
    // pricingModel may be a flat string (legacy) or a structured object
    // (current). Surface both: legacy string for back-compat, structured
    // detail (kind/source/hint) so the website can render integrator
    // hints like "live · quoted by registrar at purchase".
    const pricingModelRaw = meta.pricingModel;
    let pricingModelString: string | null = null;
    let pricingModelDetail: PublicSkillPricingModel | null = null;
    if (typeof pricingModelRaw === "string") {
      pricingModelString = pricingModelRaw;
    } else if (pricingModelRaw && typeof pricingModelRaw === "object") {
      const pm = pricingModelRaw as Record<string, unknown>;
      const kind = typeof pm.kind === "string" ? pm.kind : null;
      if (kind) {
        pricingModelString = kind;
        pricingModelDetail = {
          kind,
          source: typeof pm.source === "string" ? pm.source : null,
          hint: typeof pm.hint === "string" ? pm.hint : null,
        };
      }
    }
    const requiredFieldsRaw = meta.requiredFields;
    const requiredFields = Array.isArray(requiredFieldsRaw)
      ? requiredFieldsRaw.filter((f): f is string => typeof f === "string")
      : null;
    out.push({
      id,
      name: asString(raw.name) ?? id,
      description: asString(raw.description),
      basePrice:
        baseAmount !== undefined && baseAmount !== null
          ? atomicToUsdc(baseAmount as string | number | bigint)
          : null,
      pricingModel: pricingModelString,
      pricingModelDetail,
      variable: asBoolean(meta.variablePricing) || asBoolean(meta.variable),
      paymentRequired: meta.paymentRequired !== false, // default true
      requiredFields,
      requiresAssetOwnership: asBoolean(meta.requiresAssetOwnership),
      requiresCapability: asBoolean(meta.requiresCapability),
      assetType: asString(meta.assetType),
    });
  }
  return out;
}

/**
 * Flattens a cached provider into the public service shape. Returns null
 * if the provider has no marketplace extension — those aren't surfaced as
 * services on the UI (they may still exist as pure A2A agents on-chain,
 * but the marketplace site only renders priced services).
 */
export function formatServiceForPublic(
  provider: CachedProvider,
): PublicService | null {
  const ext = extractMarketplaceExtension(provider.agentCard);
  if (!ext) return null;

  const pricingExt = (ext.pricing ?? {}) as Record<string, unknown>;
  const baseAmount = pricingExt.baseAmount;
  const pricingModel = asString(pricingExt.model);
  const pricing: PublicServicePricing = {
    currency: asString(pricingExt.currency),
    basePrice:
      baseAmount !== undefined && baseAmount !== null
        ? atomicToUsdc(baseAmount as string | number | bigint)
        : null,
    pricingModel,
    variable:
      asBoolean(pricingExt.variable) || asBoolean(pricingExt.variablePricing),
    billingModel: asString(pricingExt.billingModel),
  };

  return {
    agentId: provider.agentId.toString(),
    name: extractAgentCardName(provider.agentCard),
    providerAddress: provider.walletAddress,
    agentURI: provider.agentURI,
    category: asString(ext.category),
    serviceDescription: asString(ext.serviceDescription),
    serviceLifecycle: asString(ext.serviceLifecycle),
    turnaroundEstimate: asString(ext.turnaroundEstimate),
    providerA2AUrl: extractAgentCardUrl(provider.agentCard),
    pricing,
    skills: flattenSkills(provider.agentCard),
  };
}

/**
 * Activity row for /public/v1/activity and the per-service `recentPurchases`
 * tail. Only paid challenges should be passed in — the formatter assumes
 * `transactionHash` and `verifiedAt` are populated.
 *
 * `providerName` is supplied by the caller (looked up against the cache);
 * passing null is fine and signals "provider no longer in cache".
 */
export function formatActivityRow(
  challenge: StoredChallenge,
  providerName: string | null,
): PublicActivityRow {
  // Defensive: if a non-paid row leaks through, fall back to createdAt for
  // the timestamp. Better than emitting `null` and breaking the UI.
  const timestamp = (challenge.verifiedAt ?? challenge.createdAt).toISOString();
  return {
    txHash: (challenge.transactionHash ?? "0x") as Hex,
    buyerAgentId: challenge.buyerTokenId.toString(),
    providerAgentId: challenge.providerTokenId.toString(),
    providerName,
    amount: atomicToUsdc(challenge.amount),
    skillId: challenge.skillId,
    timestamp,
  };
}
