import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

describe("hosted SKILL.md", () => {
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

  it("serves SKILL.md as text/markdown at /skill.md", async () => {
    const res = await fetch(`${gateway.baseUrl}/skill.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    const text = await res.text();
    expect(text).toMatch(/^---/);
    expect(text).toMatch(/name: daski/);
    expect(text).toMatch(/description:/);
    // Spot-check a few sections so future edits to SKILL.md don't quietly
    // drop critical content.
    expect(text).toMatch(/Prerequisites/);
    expect(text).toMatch(/eip712TypedData/);
    expect(text).toMatch(/daski_buy_service/);
    expect(text).toMatch(/daski_settle_payment/);
  });

  it("also serves at /SKILL.md and /.well-known/skill.md", async () => {
    for (const p of ["/SKILL.md", "/.well-known/skill.md"]) {
      const res = await fetch(`${gateway.baseUrl}${p}`);
      expect(res.status).toBe(200);
    }
  });
});
