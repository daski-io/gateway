import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import type { Config } from "../src/config.js";
import { CachedMarketplaceChainReader } from "../src/marketplace/cachedReader.js";
import type { MarketplaceChainReader, RecoveredFigure } from "../src/marketplace/reader.js";
import { publicServiceView, ServiceRegistrationService } from "../src/serviceRegistration/service.js";
import type { ServiceRegistrationStore, StoredRegistration } from "../src/serviceRegistration/store.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import type { AssetActionDefinitionV1 } from "../src/standardRail/types.js";

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
      supplementarySkills: [
        ...expected.ownerActions.filter((action) => action.description !== null).map((action) => ({
          skillId: action.actionId,
          name: action.name,
          description: action.description!,
          tags: ["free"],
          documentationUrl: action.documentationUrl,
          access: "gateway-managed-wallet",
          paymentRequired: false,
          assetType: action.assetType,
        })),
        ...expected.freeSkills.map((skill) => ({
          ...skill, tags: ["free"], access: "open-free-a2a", paymentRequired: false, assetType: null,
        })),
        // A paid card skill the gateway has not registered: neither an owner
        // action nor a free skill.
        {
          skillId: "rush-analysis", name: "Rush Analysis", description: "Paid; not listed.",
          tags: [], documentationUrl: null, access: "gateway-managed-wallet",
          paymentRequired: true, assetType: "lab-sample",
        },
      ],
    },
    lastRefreshedAt: new Date(expected.freshness.lastValidatedAt),
  } as unknown as StoredRegistration;
}

function unhashedAction(
  actionId: string,
  overrides: Partial<AssetActionDefinitionV1>,
): AssetActionDefinitionV1 {
  const service = fixture.services[0];
  return {
    providerAgentId: service.providerAgentId,
    serviceId: service.serviceId as Hex,
    serviceSlug: service.service.slug,
    actionId,
    assetType: "lab-sample",
    ownershipPolicy: "owner-only",
    destructive: false,
    requestSchema: {},
    responseSchema: {},
    confirmationSummarySchema: null,
    confirmationSummaryTemplate: null,
    endpoint: service.standardRail.assetActionUrl,
    replayPolicy: "stable-result",
    retentionSeconds: 60,
    validFrom: 0,
    validBefore: 4_102_444_800,
    actionDefinitionHash: hash("0"),
    ...overrides,
  };
}

function action(
  actionId: string,
  overrides: Partial<AssetActionDefinitionV1> = {},
): AssetActionDefinitionV1 {
  const { actionDefinitionHash: _unsigned, ...preimage } = unhashedAction(actionId, overrides);
  return { ...preimage, actionDefinitionHash: canonicalHash(preimage) };
}

// The signed catalog's actions behind the fixture's owner actions, plus an
// action of another service and one that is also a registered listing.
const CATALOG_ACTIONS = [
  action("get-sample-report"),
  action("discard-sample", { destructive: true }),
  action("other-service-action", { serviceId: hash("c") }),
  action("analyze-sample"),
];

describe("public v3 services contract", () => {
  it("matches the gateway-owned golden response consumed by the website", () => {
    expect({
      services: [publicServiceView(registrationFromFixture(), new Map(), CATALOG_ACTIONS)],
    }).toEqual(fixture);
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

  it("reads the detail view's reputation once through the shared public cache", async () => {
    const registration = registrationFromFixture();
    // Chain reads that answer only once released, as behind a busy RPC lane.
    let release!: () => void;
    const lane = new Promise<void>((resolve) => { release = resolve; });
    const chain = {
      addresses: {},
      getProvider: vi.fn(async () => {
        await lane;
        return { agentId: registration.providerAgentId, standardReputation: PROVIDER_REPUTATION };
      }),
      getService: vi.fn(async () => {
        await lane;
        return { serviceId: registration.serviceId, standardReputation: SERVICE_REPUTATION };
      }),
      readRecovered: vi.fn(async (figure: RecoveredFigure) => figure.kind === "provider" ? "2" : "1"),
    };
    const authority = { getProvider: vi.fn(), getService: vi.fn(), readRecovered: vi.fn() };
    const store = {
      getPublicByServiceId: vi.fn(async () => registration),
      listingCommitments: vi.fn(async () => []),
    };
    const service = new ServiceRegistrationService(
      {} as Config,
      {} as StandardRailConfig,
      store as unknown as ServiceRegistrationStore,
      authority as unknown as MarketplaceChainReader,
      {} as never,
      undefined,
      new CachedMarketplaceChainReader(chain as unknown as MarketplaceChainReader),
    );

    // A page view and two retries of a caller that gave up waiting for it.
    const views = Array.from({ length: 3 }, () => service.getPublic(registration.serviceId));
    release();
    const expected = {
      ...publicServiceView(registration),
      providerReputation: { ...PROVIDER_REPUTATION, recovered: "2" },
      serviceReputation: { ...SERVICE_REPUTATION, recovered: "1" },
    };
    await expect(Promise.all(views)).resolves.toEqual([expected, expected, expected]);
    // The retries joined the reads already in flight instead of queueing their own.
    expect(chain.getProvider).toHaveBeenCalledTimes(1);
    expect(chain.getService).toHaveBeenCalledTimes(1);
    expect(chain.readRecovered).toHaveBeenCalledTimes(2);
    // The live reader authority uses is never asked for presentation.
    expect(authority.getProvider).not.toHaveBeenCalled();
    expect(authority.getService).not.toHaveBeenCalled();
    expect(authority.readRecovered).not.toHaveBeenCalled();
  });
});

describe("public owner actions", () => {
  function catalogService(admissions: unknown[] | Error, overrides: {
    validBefore?: number;
    servicingEnabled?: boolean;
    admissionInManifest?: boolean;
    controlProfileInManifest?: boolean;
    actions?: AssetActionDefinitionV1[];
  } = {}) {
    const registration = registrationFromFixture();
    const controlProfile = {
      payload: { providerAgentId: registration.providerAgentId, origin: "https://provider.example" },
      signature: "0x03",
    };
    const catalog = {
      payload: { providerAgentId: registration.providerAgentId, actions: overrides.actions ?? CATALOG_ACTIONS },
      signature: "0x01",
    };
    const stale = {
      payload: { providerAgentId: registration.providerAgentId, actions: [action("stale-action")] },
      signature: "0x02",
    };
    const admission = {
      payload: {
        providerAgentId: registration.providerAgentId,
        providerControlProfileHash: canonicalHash(controlProfile),
        actionCatalogHash: canonicalHash(catalog),
        servicingEnabled: overrides.servicingEnabled ?? true,
        validFrom: 0,
        validBefore: overrides.validBefore ?? 4_102_444_800,
      },
      signature: "0x04",
    };
    const store = {
      getPublicByServiceId: vi.fn(async () => registration),
      listPublic: vi.fn(async () => [registration]),
      listingCommitments: vi.fn(async () => []),
      currentServicingAdmissions: vi.fn(async () => {
        if (admissions instanceof Error) throw admissions;
        return admissions.length ? admissions : [structuredClone(admission)];
      }),
    };
    const marketplace = {
      getProvider: vi.fn(async () => { throw new Error("rpc offline"); }),
      getService: vi.fn(async () => { throw new Error("rpc offline"); }),
      readRecovered: vi.fn(),
    };
    const manifest = {
      actionCatalogs: [stale, catalog],
      servicingAdmissions: overrides.admissionInManifest === false ? [] : [admission],
      providerControlProfiles: overrides.controlProfileInManifest === false ? [] : [controlProfile],
    };
    const service = new ServiceRegistrationService(
      {} as Config,
      { manifest } as unknown as StandardRailConfig,
      store as unknown as ServiceRegistrationStore,
      marketplace as unknown as MarketplaceChainReader,
      {} as never,
    );
    return { registration, service, store };
  }

  it("lists the current catalog's actions for the service on the list and detail views", async () => {
    const { registration, service } = catalogService([]);
    const expectedActions = fixture.services[0].ownerActions;

    expect((await service.listPublic(10)).services[0]!.ownerActions).toEqual(expectedActions);
    const detail = await service.getPublic(registration.serviceId);
    expect(detail.ownerActions).toEqual(expectedActions);
    expect(detail.freeSkills).toEqual(fixture.services[0].freeSkills);
  });

  it.each([
    { label: "the admission read fails", admissions: new Error("db offline") },
    { label: "the admission has expired", admissions: [], validBefore: 1 },
    { label: "servicing is disabled", admissions: [], servicingEnabled: false },
    { label: "the manifest does not carry the current admission", admissions: [], admissionInManifest: false },
    { label: "the manifest has no matching control profile", admissions: [], controlProfileInManifest: false },
  ])("lists no owner actions when $label", async ({ admissions, ...overrides }) => {
    const { registration, service } = catalogService(admissions, overrides);

    expect((await service.listPublic(10)).services[0]!.ownerActions).toEqual([]);
    const detail = await service.getPublic(registration.serviceId);
    expect(detail.ownerActions).toEqual([]);
    // Free skills come from the card alone.
    expect(detail.freeSkills).toEqual(fixture.services[0].freeSkills);
  });

  it("leaves out an action whose definition hash does not match it", async () => {
    const tampered = { ...action("get-sample-report"), destructive: true };
    const { registration, service } = catalogService([], {
      actions: [tampered, action("discard-sample", { destructive: true })],
    });

    expect((await service.getPublic(registration.serviceId)).ownerActions.map((item) => item.actionId))
      .toEqual(["discard-sample"]);
  });

  it("keeps a free skill whose id is another service's owner action", () => {
    const view = publicServiceView(registrationFromFixture(), new Map(), [
      ...CATALOG_ACTIONS,
      action("get-pricing", { serviceId: hash("c") }),
    ]);
    expect(view.freeSkills.map((item) => item.skillId)).toEqual(["get-pricing"]);
  });

  it("presents a stored card from before supplementary skills with bare owner actions", () => {
    const registration = registrationFromFixture();
    delete (registration.card as { supplementarySkills?: unknown }).supplementarySkills;

    const view = publicServiceView(registration, new Map(), CATALOG_ACTIONS);
    expect(view.ownerActions.map((item) => [item.actionId, item.name, item.description]))
      .toEqual([["get-sample-report", "get-sample-report", null], ["discard-sample", "discard-sample", null]]);
    expect(view.freeSkills).toEqual([]);
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
