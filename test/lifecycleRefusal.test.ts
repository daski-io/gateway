import { describe, expect, it } from "vitest";
import { providerLifecycleRefusal } from "../src/standardRail/lifecycleRefusal.js";

const refusal = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" } });

describe("provider lifecycle refusals", () => {
  it("names an unfinished artifact read to the buyer", async () => {
    const error = await providerLifecycleRefusal("artifact", refusal(409, { error: "artifact_unavailable" }));
    expect(error).toMatchObject({ code: "ARTIFACT_NOT_AVAILABLE", status: 409, retryable: true,
      requiresNewSignature: false, paymentMayHaveSettled: false });
  });

  it.each([
    ["artifact", 409, { error: "artifact_unavailable", detail: "extra" }],
    ["artifact", 409, { error: "lifecycle_rejected" }],
    ["artifact", 401, { error: "artifact_unavailable" }],
    ["status", 409, { error: "artifact_unavailable" }],
  ])("keeps a %s refusal with status %s and an unexpected body internal", async (action, status, body) => {
    expect(await providerLifecycleRefusal(action, refusal(status, body))).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("keeps an unreadable refusal internal", async () => {
    const response = new Response("not json", { status: 409, headers: { "content-type": "text/plain" } });
    expect(await providerLifecycleRefusal("artifact", response)).toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
