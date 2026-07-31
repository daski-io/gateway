import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

describe("GET /.well-known/daski-chain.json", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "p",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("returns the gateway's configured chain + contracts + schemas", async () => {
    const res = await fetch(
      `${gateway.baseUrl}/.well-known/daski-chain.json`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.chainId).toBe(gateway.config.chainId);
    expect(body.network).toBe(gateway.config.network);

    const contracts = body.contracts as Record<string, string>;
    expect(contracts.identityRegistry).toBe(gateway.config.identityRegistryAddress);
    expect(contracts.providerRegistry).toBe(gateway.config.providerRegistryAddress);
    expect(contracts.serviceRegistry).toBe(gateway.config.serviceRegistryAddress);
    expect(contracts.paymentRouter).toBe(gateway.config.paymentRouterAddress);
    expect(contracts.x402Adapter).toBe(gateway.config.x402AdapterAddress);
    expect(contracts.usdc).toBe(gateway.config.usdc.address);
    expect(contracts.eas).toBe(gateway.config.easAddress);

    // Optional addresses aren't configured in the test fixture, so the
    // keys must be omitted (not present as null/undefined) — clients use
    // `'permitAdapter' in contracts` to test for presence.
    expect("permitAdapter" in contracts).toBe(false);
    expect("approvalAdapter" in contracts).toBe(false);
    expect("reputationStorage" in contracts).toBe(false);
    expect("reputationRegistry" in contracts).toBe(false);
    expect("validationRegistry" in contracts).toBe(false);

    const schemas = body.schemas as Record<string, string>;
    expect(schemas.easConfirmation).toBe(gateway.config.easConfirmationSchemaUid);
    expect(schemas.easOutcome).toBe(gateway.config.easOutcomeSchemaUid);

    const usdcDomain = body.usdcDomain as Record<string, string>;
    expect(usdcDomain).toEqual(gateway.config.usdc);
  });

  it("includes optional contract addresses when configured", async () => {
    await gateway.close();
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "p",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
      configOverrides: {
        permitAdapterAddress: "0x000000000000000000000000000000000000b001",
        approvalAdapterAddress: "0x000000000000000000000000000000000000b002",
        reputationStorageAddress: "0x000000000000000000000000000000000000b003",
        reputationRegistryAddress: "0x000000000000000000000000000000000000b004",
        validationRegistryAddress: "0x000000000000000000000000000000000000b005",
      },
    });

    const res = await fetch(
      `${gateway.baseUrl}/.well-known/daski-chain.json`,
    );
    const body = (await res.json()) as { contracts: Record<string, string> };
    expect(body.contracts.permitAdapter).toBe(
      "0x000000000000000000000000000000000000b001",
    );
    expect(body.contracts.approvalAdapter).toBe(
      "0x000000000000000000000000000000000000b002",
    );
    expect(body.contracts.reputationStorage).toBe(
      "0x000000000000000000000000000000000000b003",
    );
    expect(body.contracts.reputationRegistry).toBe(
      "0x000000000000000000000000000000000000b004",
    );
    expect(body.contracts.validationRegistry).toBe(
      "0x000000000000000000000000000000000000b005",
    );
  });
});
