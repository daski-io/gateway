import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import type { Config } from "../src/config.js";
import type { MarketplaceChainReader, RecoveredFigure } from "../src/marketplace/reader.js";
import { publicServiceView, ServiceRegistrationService } from "../src/serviceRegistration/service.js";
import type { ServiceRegistrationStore, StoredRegistration } from "../src/serviceRegistration/store.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";

const fixture = JSON.parse(readFileSync(
  new URL("./vectors/public-v3-services.json", import.meta.url),
  "utf8",
)) as { services: Array<ReturnType<typeof publicServiceView>> };

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;

function registrationFromFixture(): StoredRegistration {
  const expected = structuredClone(fixture.services[0]);
  if (!expected.freshness.lastValidatedAt) {
    throw new Error("public services fixture requires a validation timestamp");
  }
  const skills = expected.skills.map((skill) => {
    const { listing, ...published } = skill;
    void listing;
    return published;
  });
  return {
    registrationId: expected.gatewayRegistrationId,
    providerAgentId: expected.providerAgentId,
    serviceId: expected.serviceId,
    serviceSlug: expected.service.slug,
    serviceVersion: expected.service.version,
    agentCardUrl: expected.agentCardUrl,
    providerPayee: expected.providerPayee,
    prepared: {
      listings: expected.skills.map((skill) => ({
        listingId: skill.listing.listingId,
        listingKey: skill.listing.listingKey,
        skillId: skill.skillId,
        skillContractHash: skill.skillContractHash,
        paymentRequired: skill.listing.paymentRequired,
        acceptingNewOrders: skill.acceptingNewOrders,
        splitterAddress: skill.listing.splitterAddress,
      })),
    },
    card: {
      providerAgentId: expected.providerAgentId,
      name: expected.name,
      description: expected.description,
      legal: expected.legal,
      service: expected.service,
      standardRail: expected.standardRail,
      serviceContractHash: hash("1"),
      skillContractSetHash: hash("2"),
      skills,
    },
    lastRefreshedAt: new Date(expected.freshness.lastValidatedAt),
  } as unknown as StoredRegistration;
}

describe("public v3 services contract", () => {
  it("matches the gateway-owned golden response consumed by the website", () => {
    expect({ services: [publicServiceView(registrationFromFixture())] }).toEqual(fixture);
    expect(fixture.services[0].skills[0]).toMatchObject({ acceptingNewOrders: true });
    expect(fixture.services[0].skills[0].contract).not.toHaveProperty("acceptingNewOrders");
  });

  it.each([
    {
      label: "the recovered figures",
      answer: async (figure: RecoveredFigure) => figure.kind === "provider" ? "2" : "1",
      provider: "2",
      service: "1",
    },
    { label: "null where recoveries are unsupported", answer: async () => null, provider: null, service: null },
    {
      label: "null when the recovered reads fail",
      answer: async () => { throw new Error("rpc offline"); },
      provider: null,
      service: null,
    },
  ])("adds $label to the detail view's reputation blocks", async ({ answer, provider, service: recovered }) => {
    const { registration, marketplace, service } = serviceDetail(answer);

    await expect(service.getPublic(registration.serviceId)).resolves.toEqual({
      ...publicServiceView(registration),
      providerReputation: { ...PROVIDER_REPUTATION, recovered: provider },
      serviceReputation: { ...SERVICE_REPUTATION, recovered },
    });
    // Each figure is read after the registry reads, at its own block's safe block.
    expect(marketplace.getProvider).toHaveBeenCalledWith(BigInt(registration.providerAgentId));
    expect(marketplace.getService).toHaveBeenCalledWith(registration.serviceId);
    expect(marketplace.readRecovered).toHaveBeenCalledTimes(2);
    expect(marketplace.readRecovered)
      .toHaveBeenCalledWith({ kind: "provider", agentId: BigInt(registration.providerAgentId) }, 110n);
    expect(marketplace.readRecovered)
      .toHaveBeenCalledWith({ kind: "service", serviceId: registration.serviceId }, 111n);
  });

  it("reads no recovered figure when the reputation reads fail", async () => {
    const { registration, marketplace, service } = serviceDetail(async () => "1", true);

    await expect(service.getPublic(registration.serviceId)).resolves.toEqual({
      ...publicServiceView(registration),
      providerReputation: null,
      serviceReputation: null,
    });
    expect(marketplace.readRecovered).not.toHaveBeenCalled();
  });
});

const PROVIDER_REPUTATION = {
  completed: "3", failed: "2", canceled: "0", confirmed: "1", notConfirmed: "0", transactions: "5", safeBlock: "110",
};
const SERVICE_REPUTATION = {
  completed: "3", failed: "2", canceled: "0", confirmed: "1", notConfirmed: "0",
  refundedAmount: "0", transactions: "5", safeBlock: "111",
};

function serviceDetail(readRecovered: MarketplaceChainReader["readRecovered"], readsFail = false) {
  const registration = registrationFromFixture();
  const marketplace = {
    getProvider: vi.fn(async () => {
      if (readsFail) throw new Error("rpc offline");
      return { agentId: registration.providerAgentId, standardReputation: PROVIDER_REPUTATION };
    }),
    getService: vi.fn(async () => ({ serviceId: registration.serviceId, standardReputation: SERVICE_REPUTATION })),
    readRecovered: vi.fn(readRecovered),
  };
  const store = {
    getPublicByServiceId: vi.fn(async () => registration),
    listingCommitments: vi.fn(async () => []),
  };
  const service = new ServiceRegistrationService(
    {} as Config,
    {} as StandardRailConfig,
    store as unknown as ServiceRegistrationStore,
    marketplace as unknown as MarketplaceChainReader,
    {} as never,
  );
  return { registration, marketplace, service };
}
