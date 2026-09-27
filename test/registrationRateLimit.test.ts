import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { configureMiddleware } from "../src/http/middleware.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";

afterEach(() => { vi.useRealTimers(); });

async function setup(exhaustedNamespace?: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
  const buckets = new Map<string, { count: number; resetAt: Date }>();
  const store = {
    async consumeRateLimitBucket(key: string, windowMs: number) {
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt.getTime() <= Date.now()) {
        bucket = { count: key.startsWith(`${exhaustedNamespace}:`) ? 100 : 0, resetAt: new Date(Date.now() + windowMs) };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket;
    },
  };
  const app = express();
  configureMiddleware(app, store, {
    nodeEnv: "production", dynamicServiceRegistrationEnabled: true,
    stateChangeGlobalMaxPerMinute: 100, publicReadMaxPerMinute: 100,
    publicReadGlobalMaxPerMinute: 100,
  } as Config, {
    abuse: { walletChallengesPerClientPerMinute: 30, walletChallengesGlobalPerMinute: 100 },
  } as StandardRailConfig);
  app.use((_req, res) => { res.json({ accepted: true }); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    root: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function expectPacingHeaders(response: Response, seconds: string) {
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe(seconds);
  expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
  const exposed = response.headers.get("access-control-expose-headers")!.toLowerCase().split(",");
  expect(exposed).toEqual(expect.arrayContaining([
    "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
  ]));
}

describe("registration client pacing", () => {
  it("shares ten requests across polls and posts for three services and permits retry after reset", async () => {
    const test = await setup();
    try {
      for (let i = 0; i < 10; i++) {
        const path = i % 2 ? `/v1/service-registrations/service-${i % 3}` : "/v1/service-registrations";
        const response = await fetch(`${test.root}${path}`, i % 2 ? {} : {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: { providerAgentId: "42" } }),
        });
        expect(response.status).toBe(200);
        await response.json();
      }
      vi.setSystemTime(Date.now() + 15_200);
      const limited = await fetch(`${test.root}/v1/service-registrations/service-0`);
      expectPacingHeaders(limited, "45");
      expect(limited.headers.get("x-ratelimit-limit")).toBe("10");
      expect(await limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
      // Owner swaps consume the same client bucket.
      const swap = await fetch(`${test.root}/v1/owner-swaps`, { method: "POST" });
      expectPacingHeaders(swap, "45");
      await swap.json();
      vi.setSystemTime(Date.now() + 45_000);
      const retry = await fetch(`${test.root}/v1/service-registrations/service-0`);
      expect(retry.status).toBe(200);
      expect(retry.headers.has("retry-after")).toBe(false);
      await retry.json();
    } finally { await test.close(); }
  });

  it.each(["service-registration-global", "service-registration-resource"])(
    "also supplies pacing headers when the %s bucket is exhausted", async (namespace) => {
      const test = await setup(namespace);
      try {
        const response = await fetch(`${test.root}/v1/service-registrations`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: { providerAgentId: "42" } }),
        });
        expectPacingHeaders(response, "60");
        expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
      } finally { await test.close(); }
    },
  );
});
