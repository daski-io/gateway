import { canonicalHash } from "../../src/standardRail/canonical.js";
import { parseProviderServiceCard } from "../../src/serviceRegistration/card.js";
import type { ProviderServiceCard } from "../../src/serviceRegistration/types.js";
import { REQUEST_SCHEMA, SERVICE_RESULT_SCHEMA } from "./providerWire.js";
import { SERVICE, serviceIdOf } from "./railManifestExamples.js";

/// A synthetic hosted provider runtime: many providers under one origin, each
/// under /p/<agent id>/, with the card texts a hosted runtime publishes. Used
/// by the provider approval tests. Nothing here is live or production-derived.

export const HOSTED_ORIGIN = "https://hosted.example";
export const HOSTED_AUDIENCE = "https://hosted.example/";
export const hostedBase = (providerAgentId: string) => `${HOSTED_ORIGIN}/p/${providerAgentId}`;
export const HOSTED_OUTCOME_ID = "create-note";
export const HOSTED_PRICE = "250000";

export type StandardRailTexts = Record<
  "origin" | "providerAudience" | "quoteUrl" | "dispatchUrl" | "dispatchStatusUrl" | "lifecycleUrl" |
  "assetQueryUrl" | "assetActionUrl",
  string
>;

/** The card's standard-rail block for a provider under the hosted origin. */
export function hostedStandardRail(providerAgentId: string, origin = HOSTED_ORIGIN): StandardRailTexts {
  const base = `${origin}/p/${providerAgentId}`;
  return {
    origin,
    providerAudience: `${origin}/`,
    quoteUrl: `${base}/standard-rail/quote`,
    dispatchUrl: `${base}/standard-rail/dispatch`,
    dispatchStatusUrl: `${base}/standard-rail/dispatch/status`,
    lifecycleUrl: `${base}/standard-rail/lifecycle`,
    assetQueryUrl: `${base}/standard-rail/assets/query`,
    assetActionUrl: `${base}/standard-rail/assets/action`,
  };
}

/** A provider card as a hosted runtime publishes it, with one paid skill. */
export function hostedRawCard(providerAgentId: string, standardRail: Record<string, string> = hostedStandardRail(providerAgentId)) {
  const contract = {
    inputSchema: REQUEST_SCHEMA, resultSchema: SERVICE_RESULT_SCHEMA,
    pricing: { USDC: { type: "one-time", fixed_amount: HOSTED_PRICE } },
    paymentRequired: true, requiresAssetOwnership: false, assetType: null, fulfillmentMode: "automated",
    purchaseReadiness: null, capacity: { maxOpenOrders: 10 }, deadlines: { dispatchSeconds: 300 }, assetAction: null,
  };
  const skillContractHash = canonicalHash({
    schemaVersion: 1, serviceSlug: SERVICE.slug, serviceVersion: SERVICE.version, skillId: HOSTED_OUTCOME_ID, contract,
  });
  const base = `${new URL(standardRail.origin!).origin}/p/${providerAgentId}`;
  return {
    name: `Notes by hosted provider ${providerAgentId}`, description: "Keeps a note.",
    extensions: {
      "https://daski.io/a2a/v1": { legal: {
        marketplaceTermsUrl: "https://marketplace.example/terms", marketplacePrivacyUrl: "https://marketplace.example/privacy",
        providerLegalName: `Example Hosted Provider ${providerAgentId}`,
        providerTermsUrl: `${base}/terms`, providerPrivacyUrl: `${base}/privacy`,
      } },
      "https://daski.io/a2a/v2": {
        schemaVersion: 1, providerAgentId,
        service: {
          serviceId: serviceIdOf(providerAgentId), slug: SERVICE.slug, version: SERVICE.version,
          categoryFamily: "productivity", serviceType: "note-keeping", jurisdictions: ["global"], lifecycle: "available",
          turnaroundEstimate: "PT1M", acceptingNewOrders: true,
        },
        standardRail,
        skillContractSetHash: canonicalHash([{ skillId: HOSTED_OUTCOME_ID, skillContractHash }]),
        skills: [{
          skillId: HOSTED_OUTCOME_ID, skillContractHash, acceptingNewOrders: true,
          presentation: { name: "Create a note", description: "Creates a note.", examples: [], tags: ["notes"],
            documentationUrl: `${base}/docs` },
          contract,
        }],
      },
    },
  };
}

export const hostedCardUrl = (providerAgentId: string, origin = HOSTED_ORIGIN) =>
  `${origin}/p/${providerAgentId}/.well-known/agent-card.json`;

/** The card as the gateway stores it after its card check. */
export function hostedCard(
  providerAgentId: string,
  standardRail: Record<string, string> = hostedStandardRail(providerAgentId),
): ProviderServiceCard {
  return parseProviderServiceCard(hostedRawCard(providerAgentId, standardRail), {
    providerAgentId, serviceId: serviceIdOf(providerAgentId), serviceSlug: SERVICE.slug,
    serviceVersion: SERVICE.version, agentCardUrl: hostedCardUrl(providerAgentId, new URL(standardRail.origin!).origin),
  });
}
