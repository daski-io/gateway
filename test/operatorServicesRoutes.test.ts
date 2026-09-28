import express from "express";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { createServiceRegistrationRouter } from "../src/serviceRegistration/routes.js";
import { ServiceRegistrationService } from "../src/serviceRegistration/service.js";

it("authenticates hidden-service discovery and returns all pages with restorable registration IDs", async () => {
  const ids = ["12345678-1234-4123-8123-123456789abc", "22345678-1234-4123-8123-123456789abc"];
  const records = ids.map((registrationId) => ({ registrationId, providerAgentId: "7",
    serviceId: `0x${"11".repeat(32)}`, serviceSlug: "example", serviceVersion: "1", state: "ACTIVE",
    marketplaceEnabled: false, marketplaceEnabledBy: "catalog-operator",
    marketplaceEnabledAt: new Date("2026-09-27T00:00:00Z"),
    // These internal details must not appear in the operator inventory.
    idempotencyKey: "private", canonicalIntent: { secret: "private" },
  }));
  const listOperator = vi.fn(async (_hidden: boolean, limit: number, after: string | null) =>
    records.filter((record) => after === null || record.registrationId > after).slice(0, limit));
  const service = Object.assign(Object.create(ServiceRegistrationService.prototype) as ServiceRegistrationService,
    { store: { listOperator } });
  const app = express();
  app.use(createServiceRegistrationRouter({ config: {
    dynamicServiceRegistrationEnabled: true, catalogOperatorToken: "operator-test-token",
  } as never, service }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/operator/v1/services`;
  const headers = { authorization: "Bearer operator-test-token" };
  try {
    expect((await fetch(base + "?hidden=true")).status).toBe(401);
    expect(listOperator).not.toHaveBeenCalled();
    for (const query of ["", "?hidden=1", "?hidden=true&cursor=bad", "?hidden=true&limit=101", "?hidden=true&hidden=false"]) {
      expect((await fetch(base + query, { headers })).status).toBe(400);
    }
    const first = await fetch(base + "?hidden=true&limit=1", { headers });
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ services: [{ registrationId: ids[0], providerAgentId: "7",
      serviceId: `0x${"11".repeat(32)}`, serviceSlug: "example", serviceVersion: "1", state: "ACTIVE",
      marketplaceEnabled: false, marketplaceEnabledBy: "catalog-operator",
      marketplaceEnabledAt: "2026-09-27T00:00:00.000Z",
    }], nextCursor: ids[0] });
    const second = await fetch(base + `?hidden=true&limit=1&cursor=${ids[0]}`, { headers });
    expect(await second.json()).toMatchObject({ services: [{ registrationId: ids[1] }], nextCursor: null });
    expect(listOperator).toHaveBeenLastCalledWith(true, 2, ids[0]);
    await fetch(base + "?hidden=false", { headers });
    expect(listOperator).toHaveBeenLastCalledWith(false, 51, null);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
