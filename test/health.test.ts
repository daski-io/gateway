import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

describe("health surfaces", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway();
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("separates process liveness from dependency readiness", async () => {
    const live = await fetch(`${gateway.baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: "alive" });

    const beforeIndexer = await fetch(`${gateway.baseUrl}/health/ready`);
    expect(beforeIndexer.status).toBe(503);
    expect(await beforeIndexer.json()).toMatchObject({
      status: "unready",
      database: { ready: true },
      cache: { ready: true },
      indexer: { ready: false },
    });

    await gateway.bundle.indexer.tick();
    const ready = await fetch(`${gateway.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: "ready",
      database: { ready: true },
      cache: { ready: true },
      indexer: { ready: true },
    });
  });

  it("does not retain the retired /health compatibility route", async () => {
    expect((await fetch(`${gateway.baseUrl}/health`)).status).toBe(404);
  });
});
