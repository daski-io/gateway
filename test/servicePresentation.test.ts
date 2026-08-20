import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import type { MarketplaceChainReader } from "../src/marketplace/reader.js";
import { AdmittedServiceResolver } from "../src/integration/admittedServicePresentation.js";
import type { StandardListing } from "../src/standardRail/types.js";

const ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const SERVICE_ID = `0x${"22".repeat(32)}` as Hex;

function listing(skillId = "form-entity"): StandardListing {
  return {
    commitment: { payload: { providerAgentId: "8327", serviceId: SERVICE_ID } },
    offer: { payload: { skillId } },
  } as StandardListing;
}

function serviceRecord(providerAgentId = "8327") {
  return {
    providerAgentId,
    serviceId: SERVICE_ID,
    serviceSlug: "entity-formation",
    version: "1",
    serviceUri: "https://provider.example/agent-cards/entity-formation.json",
    serviceWallet: ADDRESS,
    createdAt: "1",
    active: true,
    standardReputation: {
      completed: "0", failed: "0", canceled: "0", confirmed: "0",
      notConfirmed: "0", refundedAmount: "0", transactions: "0", safeBlock: "1",
    },
  };
}

function reader(providerAgentId = "8327"): MarketplaceChainReader {
  return {
    addresses: {
      identityRegistry: ADDRESS,
      agentIndex: ADDRESS,
      providerRegistry: ADDRESS,
      serviceRegistry: ADDRESS,
      validationRegistry: ADDRESS,
      reputationStorage: ADDRESS,
    },
    resolveWallet: vi.fn(),
    listProviders: vi.fn(),
    getProvider: vi.fn(),
    getService: vi.fn(async () => serviceRecord(providerAgentId)),
  };
}

function agentCard() {
  return {
    name: "Entity Formation",
    description: "Form and manage US business entities.",
    supportedInterfaces: [{
      url: "https://provider.example/a2a/entity-formation",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    }],
    skills: [{
      id: "form-entity",
      name: "Form Entity",
      description: "Form a supported US business entity.",
      tags: ["formation"],
    }, {
      id: "file-ein",
      name: "File EIN",
      description: "Obtain an EIN for a managed entity.",
      tags: ["tax"],
    }],
    extensions: {
      "https://daski.xyz/a2a/v1": {
        providerAgentId: "8327",
        onChainServiceId: SERVICE_ID,
        serviceVersion: "1",
        categoryFamily: "business-formation",
        serviceType: "entity-formation",
        jurisdictions: ["US"],
        turnaroundEstimate: "1 business day – 6 weeks",
        serviceLifecycle: "asset-lifecycle",
      },
    },
  };
}

describe("admitted service presentation", () => {
  it("uses the registered provider Agent Card and caches the result", async () => {
    const chainReader = reader();
    const fetchCard = vi.fn(async () => agentCard());
    const resolver = new AdmittedServiceResolver(chainReader, fetchCard);

    await expect(resolver.resolve(listing())).resolves.toMatchObject({
      service: {
        slug: "entity-formation",
        name: "Entity Formation",
        jurisdictions: ["US"],
      },
      skill: { id: "form-entity", name: "Form Entity" },
    });
    await resolver.resolve(listing());

    expect(chainReader.getService).toHaveBeenCalledTimes(1);
    expect(fetchCard).toHaveBeenCalledTimes(1);
  });

  it("rejects a registry record owned by another provider", async () => {
    const fetchCard = vi.fn(async () => agentCard());
    const resolver = new AdmittedServiceResolver(reader("9999"), fetchCard);

    await expect(resolver.resolve(listing())).rejects.toThrow("ADMITTED_SERVICE_REGISTRY_MISMATCH");
    expect(fetchCard).not.toHaveBeenCalled();
  });

  it("resolves each admitted skill independently for a shared service", async () => {
    const chainReader = reader();
    const fetchCard = vi.fn(async () => agentCard());
    const resolver = new AdmittedServiceResolver(chainReader, fetchCard);

    await expect(resolver.resolve(listing("form-entity"))).resolves.toMatchObject({
      skill: { id: "form-entity" },
    });
    await expect(resolver.resolve(listing("file-ein"))).resolves.toMatchObject({
      skill: { id: "file-ein" },
    });

    expect(fetchCard).toHaveBeenCalledTimes(2);
  });

  it("serves the stale presentation while upstream reads fail", async () => {
    const chainReader = reader();
    const fetchCard = vi.fn(async () => agentCard());
    const resolver = new AdmittedServiceResolver(chainReader, fetchCard, 0);

    const first = await resolver.resolve(listing());
    vi.mocked(chainReader.getService).mockRejectedValue(new Error("RPC_DOWN"));

    await expect(resolver.resolve(listing())).resolves.toEqual(first);
    await expect(resolver.refresh(listing())).rejects.toThrow("RPC_DOWN");
    await expect(resolver.resolve(listing())).resolves.toEqual(first);
  });

  it("stops serving a presentation past the stale limit", async () => {
    const chainReader = reader();
    const fetchCard = vi.fn(async () => agentCard());
    const resolver = new AdmittedServiceResolver(chainReader, fetchCard, 0, 0);

    await resolver.resolve(listing());
    vi.mocked(chainReader.getService).mockRejectedValue(new Error("RPC_DOWN"));

    await expect(resolver.resolve(listing())).rejects.toThrow("RPC_DOWN");
  });

  it("evicts the stale presentation when the registry rejects the listing", async () => {
    const chainReader = reader();
    const fetchCard = vi.fn(async () => agentCard());
    const resolver = new AdmittedServiceResolver(chainReader, fetchCard, 0);

    await resolver.resolve(listing());
    vi.mocked(chainReader.getService).mockResolvedValue({ ...serviceRecord(), active: false });

    await expect(resolver.refresh(listing())).rejects.toThrow("ADMITTED_SERVICE_REGISTRY_MISMATCH");
    await expect(resolver.resolve(listing())).rejects.toThrow("ADMITTED_SERVICE_REGISTRY_MISMATCH");
  });

  it("evicts the stale presentation when the provider card stops publishing the skill", async () => {
    const chainReader = reader();
    const fetchCard = vi.fn(async () => agentCard());
    const resolver = new AdmittedServiceResolver(chainReader, fetchCard, 0);

    await resolver.resolve(listing());
    fetchCard.mockResolvedValue({ ...agentCard(), skills: [] });

    await expect(resolver.refresh(listing())).rejects.toThrow("ADMITTED_SKILL_NOT_PUBLISHED");
    await expect(resolver.resolve(listing())).rejects.toThrow("ADMITTED_SKILL_NOT_PUBLISHED");
  });

  it("refresh reuses a fresh presentation without reloading", async () => {
    const chainReader = reader();
    const fetchCard = vi.fn(async () => agentCard());
    const resolver = new AdmittedServiceResolver(chainReader, fetchCard);

    await resolver.resolve(listing());
    await resolver.refresh(listing());

    expect(chainReader.getService).toHaveBeenCalledTimes(1);
    expect(fetchCard).toHaveBeenCalledTimes(1);
  });
});
