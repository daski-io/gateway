import type { Hex } from "viem";
import { canonicalHash } from "../standardRail/canonical.js";
import {
  compileClosedRequestSchema,
  compileClosedResponseSchema,
} from "../standardRail/schema.js";
import type {
  ProviderServiceCard,
  PublishedSkillContract,
} from "./types.js";
import {
  parseAssetAction,
  parseUsdcPricing,
} from "./contractValidation.js";

export const DASKI_CONTRACT_EXTENSION_URI = "https://daski.xyz/a2a/v2";
const DASKI_SERVICE_EXTENSION_URI = "https://daski.xyz/a2a/v1";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function closed(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const found = record(value, label);
  const actual = Object.keys(found);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) throw new Error(`${label} fields are invalid`);
  return found;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error(`${label} is invalid`);
  return value;
}

function normalizedId(value: unknown, label: string, maximum: number): string {
  const found = text(value, label, maximum);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(found)) throw new Error(`${label} is invalid`);
  return found;
}

function hash(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
  return value.toLowerCase() as Hex;
}

function stringArray(value: unknown, label: string, maximum = 64): string[] {
  if (
    !Array.isArray(value) || value.length > maximum ||
    value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 256)
  ) throw new Error(`${label} is invalid`);
  return value as string[];
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function sameOriginUrl(value: unknown, label: string, origin: string): string {
  const parsed = new URL(text(value, label, 2_048));
  if (
    parsed.protocol !== "https:" || parsed.origin !== origin ||
    parsed.username || parsed.password || parsed.hash
  ) throw new Error(`${label} must be same-origin HTTPS`);
  return parsed.toString();
}
function httpsUrl(value: unknown, label: string): string {
  const parsed = new URL(text(value, label, 2_048));
  if (
    parsed.protocol !== "https:" ||
    parsed.username || parsed.password || parsed.hash
  ) throw new Error(`${label} must be credential-free HTTPS`);
  return parsed.toString();
}


function parseContract(
  raw: unknown,
  serviceSlug: string,
  serviceVersion: string,
  skillId: string,
  expectedHash: Hex,
): PublishedSkillContract["contract"] {
  const value = closed(raw, [
    "inputSchema", "resultSchema", "pricing", "paymentRequired",
    "requiresAssetOwnership", "assetType", "fulfillmentMode",
    "capacity", "deadlines", "assetAction",
  ], "skill contract");
  const inputSchema = record(value.inputSchema, "skill input schema");
  const resultSchema = record(value.resultSchema, "skill result schema");
  compileClosedRequestSchema(inputSchema);
  compileClosedResponseSchema(resultSchema);
  const paymentRequired = booleanValue(value.paymentRequired, "paymentRequired");
  const pricing = parseUsdcPricing(value.pricing, paymentRequired);
  const requiresAssetOwnership = booleanValue(
    value.requiresAssetOwnership,
    "requiresAssetOwnership",
  );
  const fulfillmentMode = text(value.fulfillmentMode, "fulfillment mode", 16);
  if (!["automated", "human", "hybrid"].includes(fulfillmentMode)) {
    throw new Error("fulfillment mode is invalid");
  }
  if (
    value.assetType !== null &&
    (typeof value.assetType !== "string" || value.assetType.length > 128)
  ) throw new Error("skill asset type is invalid");
  const assetType = value.assetType as string | null;
  const capacity = closed(value.capacity, ["maxOpenOrders"], "skill capacity");
  if (
    !Number.isSafeInteger(capacity.maxOpenOrders) ||
    (capacity.maxOpenOrders as number) < 1 ||
    (capacity.maxOpenOrders as number) > 100_000
  ) throw new Error("skill capacity is invalid");
  const deadlines = record(value.deadlines, "skill deadlines");
  if (
    Object.keys(deadlines).some((key) =>
      !["dispatchSeconds", "fulfillmentSeconds"].includes(key)) ||
    Object.values(deadlines).some((seconds) =>
      !Number.isSafeInteger(seconds) || (seconds as number) < 1 ||
      (seconds as number) > 31_536_000)
  ) throw new Error("skill deadlines are invalid");
  const assetAction = parseAssetAction({
    raw: value.assetAction,
    inputSchema,
    requiresAssetOwnership,
    assetType,
  });
  const contract = {
    inputSchema,
    resultSchema,
    pricing,
    paymentRequired,
    requiresAssetOwnership,
    assetType,
    fulfillmentMode: fulfillmentMode as "automated" | "human" | "hybrid",
    capacity: { maxOpenOrders: capacity.maxOpenOrders as number },
    deadlines,
    assetAction,
  };
  const actualHash = canonicalHash({
    schemaVersion: 1,
    serviceSlug,
    serviceVersion,
    skillId,
    contract,
  });
  if (actualHash !== expectedHash) throw new Error("skill contract hash mismatch");
  return contract;
}

function parseSkill(
  raw: unknown,
  serviceSlug: string,
  serviceVersion: string,
): PublishedSkillContract {
  const value = closed(raw, [
    "skillId", "skillContractHash", "acceptingNewOrders", "presentation", "contract",
  ], "published skill");
  const skillId = normalizedId(value.skillId, "skill id", 96);
  const skillContractHash = hash(value.skillContractHash, "skill contract hash");
  const presentation = closed(value.presentation, [
    "name", "description", "examples", "tags", "documentationUrl",
  ], "skill presentation");
  const documentationUrl = new URL(text(
    presentation.documentationUrl,
    "skill documentation URL",
    2_048,
  ));
  if (
    documentationUrl.protocol !== "https:" ||
    documentationUrl.username || documentationUrl.password || documentationUrl.hash
  ) throw new Error("skill documentation URL is invalid");
  return {
    skillId,
    skillContractHash,
    acceptingNewOrders: booleanValue(
      value.acceptingNewOrders,
      "skill acceptingNewOrders",
    ),
    presentation: {
      name: text(presentation.name, "skill name", 160),
      description: text(presentation.description, "skill description", 32_000),
      examples: stringArray(presentation.examples, "skill examples", 32),
      tags: stringArray(presentation.tags, "skill tags", 64),
      documentationUrl: documentationUrl.toString(),
    },
    contract: parseContract(
      value.contract,
      serviceSlug,
      serviceVersion,
      skillId,
      skillContractHash,
    ),
  };
}

export function parseProviderServiceCard(
  raw: unknown,
  expected: {
    providerAgentId: string;
    serviceId: Hex;
    serviceSlug: string;
    serviceVersion: string;
    agentCardUrl: string;
  },
): ProviderServiceCard {
  const card = record(raw, "provider AgentCard");
  const extensions = record(card.extensions, "provider AgentCard extensions");
  const serviceExtension = record(
    extensions[DASKI_SERVICE_EXTENSION_URI],
    "Daski v1 extension",
  );
  const rawLegal = closed(serviceExtension.legal, [
    "marketplaceTermsUrl", "marketplacePrivacyUrl", "providerLegalName",
    "providerTermsUrl", "providerPrivacyUrl",
  ], "service legal metadata");
  const legal = {
    marketplaceTermsUrl: httpsUrl(rawLegal.marketplaceTermsUrl, "marketplace terms URL"),
    marketplacePrivacyUrl: httpsUrl(rawLegal.marketplacePrivacyUrl, "marketplace privacy URL"),
    providerLegalName: text(rawLegal.providerLegalName, "provider legal name", 512),
    providerTermsUrl: httpsUrl(rawLegal.providerTermsUrl, "provider terms URL"),
    providerPrivacyUrl: httpsUrl(rawLegal.providerPrivacyUrl, "provider privacy URL"),
  };
  const extension = closed(extensions[DASKI_CONTRACT_EXTENSION_URI], [
    "schemaVersion", "providerAgentId", "service", "standardRail",
    "skillContractSetHash", "skills",
  ], "Daski v2 extension");
  if (extension.schemaVersion !== 1) throw new Error("Daski v2 schema version is unsupported");
  const providerAgentId = text(extension.providerAgentId, "provider agent id", 78);
  const service = closed(extension.service, [
    "serviceId", "slug", "version", "categoryFamily", "serviceType",
    "jurisdictions", "lifecycle", "turnaroundEstimate", "acceptingNewOrders",
  ], "service contract");
  const slug = normalizedId(service.slug, "service slug", 64);
  const version = text(service.version, "service version", 32);
  const serviceId = service.serviceId === null
    ? null
    : hash(service.serviceId, "service id");
  if (
    providerAgentId !== expected.providerAgentId ||
    slug !== expected.serviceSlug ||
    version !== expected.serviceVersion ||
    serviceId !== expected.serviceId
  ) throw new Error("provider AgentCard does not match registration intent");
  const cardOrigin = new URL(expected.agentCardUrl).origin;
  const standardRail = closed(extension.standardRail, [
    "origin", "providerAudience", "quoteUrl", "dispatchUrl",
    "dispatchStatusUrl", "lifecycleUrl", "assetQueryUrl", "assetActionUrl",
  ], "standard rail endpoints");
  const origin = new URL(text(standardRail.origin, "provider origin", 2_048));
  if (
    origin.protocol !== "https:" || origin.origin !== cardOrigin ||
    origin.username || origin.password || origin.pathname !== "/" ||
    origin.search || origin.hash
  ) throw new Error("provider origin does not match AgentCard");
  if (!Array.isArray(extension.skills) || extension.skills.length > 128) {
    throw new Error("provider skills are invalid");
  }
  const skills = extension.skills.map((skill) => parseSkill(skill, slug, version));
  if (
    skills.length === 0 ||
    new Set(skills.map((skill) => skill.skillId)).size !== skills.length
  ) throw new Error("provider skill ids must be non-empty and unique");
  const skillContractSetHash = hash(
    extension.skillContractSetHash,
    "skill contract set hash",
  );
  const sortedSkillContracts = skills
    .map((skill) => ({
      skillId: skill.skillId,
      skillContractHash: skill.skillContractHash,
    }))
    .sort((left, right) => left.skillId.localeCompare(right.skillId));
  if (canonicalHash(sortedSkillContracts) !== skillContractSetHash) {
    throw new Error("skill contract set hash mismatch");
  }
  const serviceContractHash = canonicalHash({
    schemaVersion: 1,
    providerAgentId,
    service: {
      serviceId,
      slug,
      version,
      categoryFamily: normalizedId(service.categoryFamily, "category family", 128),
      serviceType: normalizedId(service.serviceType, "service type", 128),
      jurisdictions: stringArray(service.jurisdictions, "jurisdictions", 64),
      lifecycle: normalizedId(service.lifecycle, "service lifecycle", 128),
      acceptingNewOrders: booleanValue(
        service.acceptingNewOrders,
        "service acceptingNewOrders",
      ),
    },
    standardRail: {
      origin: origin.origin,
      providerAudience: sameOriginUrl(
        standardRail.providerAudience,
        "provider audience",
        cardOrigin,
      ),
      quoteUrl: sameOriginUrl(standardRail.quoteUrl, "quote URL", cardOrigin),
      dispatchUrl: sameOriginUrl(standardRail.dispatchUrl, "dispatch URL", cardOrigin),
      dispatchStatusUrl: sameOriginUrl(
        standardRail.dispatchStatusUrl,
        "dispatch status URL",
        cardOrigin,
      ),
      lifecycleUrl: sameOriginUrl(standardRail.lifecycleUrl, "lifecycle URL", cardOrigin),
      assetQueryUrl: sameOriginUrl(standardRail.assetQueryUrl, "asset query URL", cardOrigin),
      assetActionUrl: sameOriginUrl(standardRail.assetActionUrl, "asset action URL", cardOrigin),
    },
    legal,
    skillContractSetHash,
  });
  return {
    name: text(card.name, "service name", 160),
    description: text(card.description, "service description", 32_000),
    providerAgentId,
    service: {
      serviceId,
      slug,
      version,
      categoryFamily: normalizedId(service.categoryFamily, "category family", 128),
      serviceType: normalizedId(service.serviceType, "service type", 128),
      jurisdictions: stringArray(service.jurisdictions, "jurisdictions", 64),
      lifecycle: normalizedId(service.lifecycle, "service lifecycle", 128),
      turnaroundEstimate: text(service.turnaroundEstimate, "turnaround estimate", 512),
      acceptingNewOrders: booleanValue(service.acceptingNewOrders, "service acceptingNewOrders"),
    },
    standardRail: {
      origin: origin.origin,
      providerAudience: sameOriginUrl(
        standardRail.providerAudience,
        "provider audience",
        cardOrigin,
      ),
      quoteUrl: sameOriginUrl(standardRail.quoteUrl, "quote URL", cardOrigin),
      dispatchUrl: sameOriginUrl(standardRail.dispatchUrl, "dispatch URL", cardOrigin),
      dispatchStatusUrl: sameOriginUrl(
        standardRail.dispatchStatusUrl,
        "dispatch status URL",
        cardOrigin,
      ),
      lifecycleUrl: sameOriginUrl(standardRail.lifecycleUrl, "lifecycle URL", cardOrigin),
      assetQueryUrl: sameOriginUrl(standardRail.assetQueryUrl, "asset query URL", cardOrigin),
      assetActionUrl: sameOriginUrl(standardRail.assetActionUrl, "asset action URL", cardOrigin),
    },
    legal,
    serviceContractHash,
    skillContractSetHash,
    skills,
  };
}
