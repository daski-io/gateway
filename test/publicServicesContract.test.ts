import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { publicServiceView } from "../src/serviceRegistration/service.js";
import type { StoredRegistration } from "../src/serviceRegistration/store.js";

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
});
