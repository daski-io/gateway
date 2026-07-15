import { iso31661, iso31662 } from "iso-3166";

export const FULFILLMENT_MODES = ["automated", "human", "hybrid"] as const;

export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number];

interface ServiceFamilyDefinition {
  slug: string;
  name: string;
  definition: string;
  serviceTypes: readonly string[];
}

/**
 * Canonical service taxonomy shared by registration validation and discovery.
 * New service types are added only when live supply or demonstrated demand
 * justifies them; every substantive family retains a controlled fallback.
 */
export const SERVICE_TAXONOMY = [
  {
    slug: "business-formation",
    name: "Business Formation",
    definition:
      "Creation and lifecycle administration of legal entities: formation, tax-ID registration connected to formation, registered-agent service, qualification, amendments, corporate records, annual corporate filings, conversion, and dissolution.",
    serviceTypes: [
      "entity-formation",
      "llc-formation",
      "business-formation-other",
    ],
  },
  {
    slug: "legal-ip",
    name: "Legal & Intellectual Property",
    definition:
      "Creation, interpretation, protection, or defense of legal rights: legal advice, contracts, trademarks, patents, copyright, licensing, policies, disputes, and legal representation.",
    serviceTypes: ["trademark-filing", "legal-ip-other"],
  },
  {
    slug: "compliance",
    name: "Compliance, Identity & Trust",
    definition:
      "Verification, monitoring, filing, and evidence that requirements are being met: licenses, permits, KYC/KYB, AML, sanctions screening, regulatory reporting, audits, certifications, privacy controls, and trust-and-safety services.",
    serviceTypes: ["compliance-other"],
  },
  {
    slug: "finance",
    name: "Finance",
    definition:
      "Financial operation and risk transfer: banking, payments, billing, accounting, bookkeeping, tax preparation and filing, treasury, custody, foreign exchange, financing, valuation, and insurance.",
    serviceTypes: ["finance-other"],
  },
  {
    slug: "domains-web",
    name: "Domains & Web",
    definition:
      "Establishing and operating a public web presence: domains, DNS, certificates, website hosting, deployment, CDN, and related web infrastructure. Website and application development remains under Software Development.",
    serviceTypes: ["domain-management", "domains-web-other"],
  },
  {
    slug: "communications",
    name: "Communications",
    definition:
      "Provisioning and maintaining channels through which an agent or entity communicates: email and agent mailboxes, phone numbers, SMS, messaging, and virtual or physical mail channels. Administrative processing after receipt belongs under Operations & Administration.",
    serviceTypes: ["agent-mailbox", "communications-other"],
  },
  {
    slug: "compute-ai",
    name: "Compute & AI",
    definition:
      "Computational capacity and machine-intelligence infrastructure: cloud compute, VPS and serverless capacity, GPU access, model training and inference, model hosting, and closely related runtime resources.",
    serviceTypes: ["compute-ai-other"],
  },
  {
    slug: "data",
    name: "Data",
    definition:
      "Obtaining, enriching, verifying, analyzing, or researching information: search, datasets, data feeds and APIs, market or company intelligence, enrichment, analytics, forecasting, geospatial and scientific data, collection, labeling, and transcription.",
    serviceTypes: ["data-other"],
  },
  {
    slug: "software-dev",
    name: "Software Development",
    definition:
      "Building or modifying software systems: web, mobile, and application development; APIs and integrations; agent and workflow automation; DevOps; QA and testing; and product engineering.",
    serviceTypes: ["software-dev-other"],
  },
  {
    slug: "design-creative",
    name: "Design & Creative",
    definition:
      "Producing creative or experiential assets: brand identity, UX/UI, graphic design, illustration, video, audio, 3D, and other creative production.",
    serviceTypes: ["design-creative-other"],
  },
  {
    slug: "marketing-growth",
    name: "Marketing & Growth",
    definition:
      "Creating awareness and demand: go-to-market strategy, positioning, SEO and agent/search optimization, content strategy, advertising, social media, community, PR, reputation, lifecycle marketing, and conversion optimization.",
    serviceTypes: ["marketing-growth-other"],
  },
  {
    slug: "sales-support",
    name: "Sales & Support",
    definition:
      "Acquiring and serving customers: lead generation, prospecting, SDR and outreach, appointment setting, sales operations, proposals, CRM work, commerce operations, customer onboarding, support, success, and retention.",
    serviceTypes: ["sales-support-other"],
  },
  {
    slug: "human-talent",
    name: "Human Talent",
    definition:
      "Acquiring and administering people: recruiting, staffing, contractors, expert networks, employer-of-record services, payroll and benefits connected to workforce administration, HR operations, and training. A person fulfilling another service does not move that service into this family.",
    serviceTypes: ["human-talent-other"],
  },
  {
    slug: "operations-admin",
    name: "Operations & Administration",
    definition:
      "Running internal business processes not primarily owned by another family: virtual assistance, back-office operations, document processing, records, procurement and vendor administration, project administration, scheduling, travel, events, mailroom processing, and general operational support.",
    serviceTypes: ["operations-admin-other"],
  },
  {
    slug: "logistics-physical",
    name: "Logistics & Physical Services",
    definition:
      "Moving, producing, storing, or acting on physical assets: courier and freight, warehousing, fulfillment, manufacturing, prototyping, printing, installation, maintenance, real estate and storage, and field services.",
    serviceTypes: ["logistics-physical-other"],
  },
  {
    slug: "other",
    name: "Other & Emerging",
    definition:
      "Services for which no existing family is defensible. This is a monitored fallback, not a permanent home for services that fit elsewhere.",
    serviceTypes: ["other"],
  },
] as const satisfies readonly ServiceFamilyDefinition[];

export type CategoryFamily = (typeof SERVICE_TAXONOMY)[number]["slug"];
export type ServiceType =
  (typeof SERVICE_TAXONOMY)[number]["serviceTypes"][number];

export const CATEGORY_FAMILY_SLUGS = SERVICE_TAXONOMY.map(
  (family) => family.slug,
) as [CategoryFamily, ...CategoryFamily[]];
export const SERVICE_TYPE_SLUGS = SERVICE_TAXONOMY.flatMap(
  (family) => family.serviceTypes,
) as [ServiceType, ...ServiceType[]];

const FAMILY_BY_SLUG = new Map<string, ServiceFamilyDefinition>(
  SERVICE_TAXONOMY.map((family) => [family.slug, family]),
);
const SERVICE_TYPES = new Set<string>(SERVICE_TYPE_SLUGS);
const ISO_COUNTRY_CODES = new Set(iso31661.map((country) => country.alpha2));
const ISO_SUBDIVISION_CODES = new Set(
  iso31662.map((subdivision) => subdivision.code),
);

export function isCategoryFamily(value: unknown): value is CategoryFamily {
  return typeof value === "string" && FAMILY_BY_SLUG.has(value);
}

export function isServiceTypeForFamily(
  categoryFamily: CategoryFamily,
  serviceType: unknown,
): serviceType is ServiceType {
  if (typeof serviceType !== "string") return false;
  return FAMILY_BY_SLUG.get(categoryFamily)!.serviceTypes.includes(serviceType);
}

export function isServiceType(value: unknown): value is ServiceType {
  return typeof value === "string" && SERVICE_TYPES.has(value);
}

export function isFulfillmentMode(value: unknown): value is FulfillmentMode {
  return (
    typeof value === "string" &&
    (FULFILLMENT_MODES as readonly string[]).includes(value)
  );
}

export function isJurisdiction(value: unknown): value is string {
  if (value === "global") return true;
  return (
    typeof value === "string" &&
    (ISO_COUNTRY_CODES.has(value) || ISO_SUBDIVISION_CODES.has(value))
  );
}

export function jurisdictionsOverlap(
  available: readonly string[],
  requested: string,
): boolean {
  if (requested === "global") return available.includes("global");
  for (const jurisdiction of available) {
    if (jurisdiction === "global" || jurisdiction === requested) return true;
    const [availableCountry, availableSubdivision] = jurisdiction.split("-");
    const [requestedCountry, requestedSubdivision] = requested.split("-");
    if (
      availableCountry === requestedCountry &&
      (!availableSubdivision || !requestedSubdivision)
    ) return true;
  }
  return false;
}

export function acceptedServiceTypes(categoryFamily: CategoryFamily): readonly string[] {
  return FAMILY_BY_SLUG.get(categoryFamily)!.serviceTypes;
}
