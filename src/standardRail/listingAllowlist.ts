import type { Hex } from "viem";
import { assertNoDuplicateJsonKeys } from "./canonical.js";

export interface ReviewedListingContent {
  serviceId: Hex;
  deliveryCommitmentHash: Hex;
  termsHash: Hex;
  requestSchemaHash: Hex;
  responseSchemaHash: Hex;
  fulfillmentObligationHash: Hex;
}

export interface ReviewedListingAllowlist {
  content: Readonly<Record<string, ReviewedListingContent>>;
  jurisdictionObligationHashes: Readonly<Record<string, Readonly<Record<string, Hex>>>>;
}

const CONTENT_KEYS = [
  "deliveryCommitmentHash",
  "fulfillmentObligationHash",
  "requestSchemaHash",
  "responseSchemaHash",
  "serviceId",
  "termsHash",
] as const;

function isNonzeroHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/i.test(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function loadReviewedListingAllowlist(
  contentText: string,
  jurisdictionsText: string,
  launchOutcomeIds: readonly string[],
): ReviewedListingAllowlist {
  let contentValue: unknown;
  let jurisdictionsValue: unknown;
  try {
    assertNoDuplicateJsonKeys(contentText);
    assertNoDuplicateJsonKeys(jurisdictionsText);
    contentValue = JSON.parse(contentText);
    jurisdictionsValue = JSON.parse(jurisdictionsText);
  } catch {
    throw new Error("Marketplace reviewed listing content configuration is malformed");
  }
  if (!exactKeys(contentValue, launchOutcomeIds) || !exactKeys(jurisdictionsValue, launchOutcomeIds)) {
    throw new Error("Marketplace reviewed listing content must cover the exact launch outcome set");
  }
  const content: Record<string, ReviewedListingContent> = {};
  const jurisdictionObligationHashes: Record<string, Readonly<Record<string, Hex>>> = {};
  for (const outcomeId of launchOutcomeIds) {
    const reviewed = contentValue[outcomeId];
    const jurisdictions = jurisdictionsValue[outcomeId];
    if (!exactKeys(reviewed, CONTENT_KEYS) ||
        CONTENT_KEYS.some((key) => !isNonzeroHash(reviewed[key]))) {
      throw new Error(`${outcomeId} reviewed listing content is invalid`);
    }
    if (!jurisdictions || typeof jurisdictions !== "object" || Array.isArray(jurisdictions) ||
        Object.keys(jurisdictions).length === 0 ||
        Object.entries(jurisdictions).some(([jurisdiction, value]) =>
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(jurisdiction) || !isNonzeroHash(value))) {
      throw new Error(`${outcomeId} reviewed jurisdiction obligation hashes are invalid`);
    }
    content[outcomeId] = Object.fromEntries(
      CONTENT_KEYS.map((key) => [key, String(reviewed[key]).toLowerCase()]),
    ) as unknown as ReviewedListingContent;
    jurisdictionObligationHashes[outcomeId] = Object.fromEntries(
      Object.entries(jurisdictions).map(([key, value]) => [key, String(value).toLowerCase()]),
    ) as Record<string, Hex>;
  }
  return { content, jurisdictionObligationHashes };
}
