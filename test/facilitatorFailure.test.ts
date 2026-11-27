import { describe, expect, it } from "vitest";
import {
  FacilitatorHttpError,
  facilitatorFailureSummary,
  facilitatorRefusalReason,
} from "../src/standardRail/facilitator.js";

describe("facilitator failure details for the logs", () => {
  it("reads the reason a refusal body names, bounded and on one line", () => {
    expect(facilitatorRefusalReason({ errorReason: "invalid_payload", errorMessage: "nonce\nused" }))
      .toBe("invalid_payload: nonce used");
    expect(facilitatorRefusalReason({ errorType: "rate_limit_exceeded" })).toBe("rate_limit_exceeded");
    expect(facilitatorRefusalReason({ errorMessage: "x".repeat(500) })).toHaveLength(200);
    expect(facilitatorRefusalReason({ success: false })).toBeUndefined();
    expect(facilitatorRefusalReason(["errorReason"])).toBeUndefined();
    expect(facilitatorRefusalReason(null)).toBeUndefined();
  });

  it("summarizes a refusal by status and reason, and other failures by kind, message and network code", () => {
    expect(facilitatorFailureSummary(new FacilitatorHttpError("settle", 502)))
      .toEqual({ errorName: "FacilitatorHttpError", status: 502 });
    expect(facilitatorFailureSummary(new FacilitatorHttpError("verify", 400, "invalid_network")))
      .toEqual({ errorName: "FacilitatorHttpError", status: 400, reason: "invalid_network" });
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(facilitatorFailureSummary(timeout))
      .toEqual({ errorName: "TimeoutError", message: "The operation was aborted due to timeout" });
    expect(facilitatorFailureSummary(Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" })))
      .toEqual({ errorName: "Error", message: "getaddrinfo", code: "ENOTFOUND" });
    expect(facilitatorFailureSummary("text")).toEqual({ errorName: "string" });
  });
});
