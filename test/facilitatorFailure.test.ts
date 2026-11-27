import { describe, expect, it } from "vitest";
import {
  FacilitatorHttpError,
  facilitatorFailureSummary,
  facilitatorRefusal,
  facilitatorRefusalReason,
} from "../src/standardRail/facilitator.js";

describe("facilitator failure details for the logs", () => {
  it("reads the reason a refusal body names, bounded and on one line", () => {
    expect(facilitatorRefusalReason({ errorReason: "invalid_payload", errorMessage: "nonce\nused" }))
      .toBe("invalid_payload: nonce used");
    expect(facilitatorRefusalReason({ errorType: "rate_limit_exceeded" })).toBe("rate_limit_exceeded");
    expect(facilitatorRefusalReason({ invalidReason: "x", invalidMessage: "y" })).toBe("x: y");
    expect(facilitatorRefusalReason({ errorMessage: "x".repeat(500) })).toHaveLength(200);
    expect(facilitatorRefusalReason({ success: false })).toBeUndefined();
    expect(facilitatorRefusalReason(["errorReason"])).toBeUndefined();
    expect(facilitatorRefusalReason(null)).toBeUndefined();
  });

  it("names a refusal's status in its code, so any log that keeps the code shows it", () => {
    const refusal = new FacilitatorHttpError("settle", 502);
    expect(refusal).toMatchObject({ name: "FacilitatorHttpError", code: "FACILITATOR_HTTP_502", status: 502 });
    expect(refusal.message).toBe("Facilitator settle rejected the request");
  });

  it("summarizes a refusal by status, reason and id, and other failures by kind, message, code and cause", () => {
    expect(facilitatorFailureSummary(new FacilitatorHttpError("settle", 502)))
      .toEqual({ errorName: "FacilitatorHttpError", status: 502 });
    expect(facilitatorFailureSummary(new FacilitatorHttpError("verify", 400, { reason: "invalid_network", correlationId: "c-1" })))
      .toEqual({ errorName: "FacilitatorHttpError", status: 400, reason: "invalid_network", correlationId: "c-1" });
    // node:https on a timed-out signal: AbortError (ABORT_ERR) caused by a TimeoutError with a numeric code.
    const timeout = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError", code: "ABORT_ERR",
      cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    });
    expect(facilitatorFailureSummary(timeout))
      .toEqual({ errorName: "AbortError", message: "The operation was aborted", code: "ABORT_ERR", causeName: "TimeoutError" });
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(facilitatorFailureSummary(reset)).toEqual({ errorName: "Error", message: "socket hang up", code: "ECONNRESET" });
    expect(facilitatorFailureSummary("text")).toEqual({ errorName: "string" });
  });
});

describe("a facilitator answer outside 2xx", () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  it("keeps the status, reason and request id of a JSON refusal", async () => {
    const refusal = await facilitatorRefusal("settle", json(400, {
      errorType: "invalid_request", errorMessage: "authorization nonce already used", correlationId: "a1b2-c3",
    }));
    expect(refusal).toMatchObject({
      status: 400, code: "FACILITATOR_HTTP_400", correlationId: "a1b2-c3",
      reason: "invalid_request: authorization nonce already used",
    });
  });

  it("keeps the status of a refusal whose body is not JSON, is too large or names an odd id", async () => {
    expect(await facilitatorRefusal("settle", new Response("<html>Bad gateway</html>",
      { status: 502, headers: { "content-type": "text/html" } })))
      .toMatchObject({ status: 502, reason: undefined, correlationId: undefined });
    expect(await facilitatorRefusal("settle", json(429, { errorMessage: "x".repeat(20_000) })))
      .toMatchObject({ status: 429, reason: undefined });
    expect(await facilitatorRefusal("verify", json(500, { correlationId: "id with spaces" })))
      .toMatchObject({ status: 500, correlationId: undefined });
  });
});
