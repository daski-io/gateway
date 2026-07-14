import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import {
  acceptedServiceTypes,
  isCategoryFamily,
  isFulfillmentMode,
  isJurisdiction,
  isServiceTypeForFamily,
} from "../serviceTaxonomy.js";

export class ServiceTaxonomyValidationError extends Error {
  constructor(errors: string[]) {
    super(`invalid service taxonomy: ${errors.join("; ")}`);
    this.name = "ServiceTaxonomyValidationError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function skillMetadata(
  skill: Record<string, unknown>,
  extensionSkills: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const id = skill.id;
  const metadata = asRecord(skill.metadata);
  const inline = metadata
    ? asRecord(metadata[DASKI_A2A_EXTENSION_URI])
    : null;
  if (inline) return inline;
  return typeof id === "string" ? asRecord(extensionSkills?.[id]) : null;
}

function validateJurisdictions(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("jurisdictions must be a non-empty array");
    return;
  }
  const seen = new Set<string>();
  for (const jurisdiction of value) {
    if (!isJurisdiction(jurisdiction)) {
      errors.push(
        "jurisdictions entries must be 'global', assigned ISO 3166-1 " +
          "alpha-2 country codes, or recognized ISO 3166-2 subdivision codes",
      );
      continue;
    }
    if (seen.has(jurisdiction)) {
      errors.push(`jurisdictions contains duplicate '${jurisdiction}'`);
    }
    seen.add(jurisdiction);
  }
  if (seen.has("global") && seen.size > 1) {
    errors.push("'global' cannot be combined with narrower jurisdictions");
  }
}

function validateSkillModes(
  card: Record<string, unknown>,
  extension: Record<string, unknown>,
  errors: string[],
): void {
  const serviceDefault = extension.fulfillmentMode;
  if (serviceDefault !== undefined && !isFulfillmentMode(serviceDefault)) {
    errors.push("service fulfillmentMode must be automated, human, or hybrid");
  }

  const skills = card.skills;
  if (!Array.isArray(skills) || skills.length === 0) {
    errors.push("skills must be a non-empty array");
    return;
  }
  const extensionSkills = asRecord(extension.skills);
  for (const skill of skills) {
    const record = asRecord(skill);
    if (!record || typeof record.id !== "string" || record.id.length === 0) {
      errors.push("every skill must have a non-empty id");
      continue;
    }
    const metadata = skillMetadata(record, extensionSkills);
    const override = metadata?.fulfillmentMode;
    if (override !== undefined && !isFulfillmentMode(override)) {
      errors.push(
        `skill '${record.id}' fulfillmentMode must be automated, human, or hybrid`,
      );
      continue;
    }
    if (!isFulfillmentMode(override ?? serviceDefault)) {
      errors.push(`skill '${record.id}' must declare fulfillmentMode`);
    }
  }
}

/**
 * Enforces the marketplace classification contract at catalog admission.
 * Invalid cards never enter the cache, so discovery, public listings,
 * embeddings, and purchases all operate on the same accepted service set.
 */
export function assertValidServiceTaxonomy(
  card: Record<string, unknown>,
): void {
  const extensions = asRecord(card.extensions);
  const extension = extensions
    ? asRecord(extensions[DASKI_A2A_EXTENSION_URI])
    : null;
  if (!extension) {
    throw new ServiceTaxonomyValidationError([
      `missing ${DASKI_A2A_EXTENSION_URI} extension`,
    ]);
  }

  const errors: string[] = [];
  const family = extension.categoryFamily;
  if (!isCategoryFamily(family)) {
    errors.push("categoryFamily is not an approved family slug");
  } else if (!isServiceTypeForFamily(family, extension.serviceType)) {
    errors.push(
      `serviceType must be one of: ${acceptedServiceTypes(family).join(", ")}`,
    );
  }
  if (Object.hasOwn(extension, "category")) {
    errors.push("category is not supported; use categoryFamily and serviceType");
  }
  validateJurisdictions(extension.jurisdictions, errors);
  validateSkillModes(card, extension, errors);

  if (errors.length > 0) {
    throw new ServiceTaxonomyValidationError(errors);
  }
}
