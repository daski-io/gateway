import { afterEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

describe("GET /.well-known/x402", () => {
  let gateway: TestGateway;

  afterEach(async () => {
    await gateway.close();
  });

  it("lists one purchase resource per admitted provider, ascending and stable", async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 7n,
          name: "later",
          priceUsdcSmallest: "2000000",
          categoryFamily: "other",
          serviceType: "other",
        },
        {
          tokenId: 2n,
          name: "earlier",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
    });

    const res = await fetch(`${gateway.baseUrl}/.well-known/x402`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      version: number;
      resources: string[];
    };

    expect(body.version).toBe(1);
    expect(body.resources).toEqual([
      `${gateway.config.publicUrl}/purchase/2`,
      `${gateway.config.publicUrl}/purchase/7`,
    ]);

    const again = (await (
      await fetch(`${gateway.baseUrl}/.well-known/x402`)
    ).json()) as { resources: string[] };
    expect(again.resources).toEqual(body.resources);
  });

  it("excludes providers without a marketplace service", async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "admitted",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
        {
          tokenId: 9n,
          name: "cardless",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
          skipExtension: true,
        },
      ],
    });

    const body = (await (
      await fetch(`${gateway.baseUrl}/.well-known/x402`)
    ).json()) as { resources: string[] };
    expect(body.resources).toEqual([
      `${gateway.config.publicUrl}/purchase/2`,
    ]);
  });

  it("serves an empty resources array when the catalog is empty", async () => {
    gateway = await startTestGateway({ providers: [] });

    const res = await fetch(`${gateway.baseUrl}/.well-known/x402`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; resources: string[] };
    expect(body.version).toBe(1);
    expect(body.resources).toEqual([]);
  });

  it("instructions carry the network, MCP endpoint, and skill prompt", async () => {
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

    const body = (await (
      await fetch(`${gateway.baseUrl}/.well-known/x402`)
    ).json()) as { instructions: string };
    expect(body.instructions).toContain(`eip155:${gateway.config.chainId}`);
    expect(body.instructions).toContain(
      `${gateway.config.publicUrl}${gateway.config.mcpPath}`,
    );
    expect(body.instructions).toContain(`${gateway.config.publicUrl}/skill.md`);
  });
});
