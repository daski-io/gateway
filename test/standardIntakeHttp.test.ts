import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createStandardRailRouter } from "../src/standardRail/routes.js";
import { standardRailError } from "../src/standardRail/errors.js";

describe("HTTP intake discovery", () => {
  it("passes a partial request without draft creation, avoids caching, and returns actionable errors", async () => {
    const getOutcomeRequirements = vi.fn().mockResolvedValue({ requestSchema: {}, selectorsRequired: ["entityType"], fieldErrors: [], supported: null });
    const issueChallenge = vi.fn();
    const service = { getOutcomeRequirements, issueChallenge };
    const app = express(); app.use(express.json()); app.use(createStandardRailRouter(service as never, "https://gateway.example"));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener failed");
    const url = `http://127.0.0.1:${address.port}/outcomes/1/form/requirements`;
    const post = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const result = await post({ request: { state: "WY" } });
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(getOutcomeRequirements).toHaveBeenCalledWith({ providerAgentId: "1", outcomeId: "form", request: { state: "WY" } });
      expect(issueChallenge).not.toHaveBeenCalled();
      const malformed = await post({ request: {}, unexpected: true });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ code: "REQUEST_SCHEMA_INVALID", paymentMayHaveSettled: false });
      getOutcomeRequirements.mockRejectedValueOnce(standardRailError("PROVIDER_INTAKE_UNAVAILABLE"));
      const unavailable = await post({ request: {} });
      expect(unavailable.status).toBe(502);
      expect(await unavailable.json()).toMatchObject({ code: "PROVIDER_INTAKE_UNAVAILABLE", retryable: true, paymentMayHaveSettled: false });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
