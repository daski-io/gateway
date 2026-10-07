import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../src/util/logger.js", () => ({ logger }));

import {
  logStandardRailError,
  standardRailError,
  standardRailLogLevel,
} from "../src/standardRail/errors.js";

beforeEach(() => vi.clearAllMocks());

describe("standard rail error log levels", () => {
  it("logs a quote the provider declined for the buyer's input as a warning", () => {
    logStandardRailError(standardRailError("PROVIDER_QUOTE_REJECTED", {
      internalMessage: "The provider declined to quote this request",
      logContext: { outcomeId: "file-ein", providerStatus: 422 },
    }));
    expect(logger.warn).toHaveBeenCalledWith("standard rail request failed", expect.objectContaining({
      code: "PROVIDER_QUOTE_REJECTED", phase: "quoting", outcomeId: "file-ein", providerStatus: 422,
    }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a sponsored submission that is still queued as info", () => {
    logStandardRailError(standardRailError("CONFIRMATION_SUBMISSION_PENDING"));
    expect(logger.info).toHaveBeenCalledWith("standard rail request failed", expect.objectContaining({
      code: "CONFIRMATION_SUBMISSION_PENDING",
    }));
    expect(standardRailLogLevel(standardRailError("PAYMENT_PENDING_RECONCILIATION"))).toBe("info");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps server faults and failed sponsored reviews visible", () => {
    expect(standardRailLogLevel(standardRailError("INTERNAL_ERROR"))).toBe("error");
    expect(standardRailLogLevel(standardRailError("PROVIDER_QUOTE_UNAVAILABLE"))).toBe("error");
    expect(standardRailLogLevel(standardRailError("SIGNATURE_VERIFICATION_UNAVAILABLE"))).toBe("error");
    expect(standardRailLogLevel(standardRailError("CONFIRMATION_SUBMISSION_FAILED"))).toBe("warn");
    expect(standardRailLogLevel(standardRailError("SIGNATURE_INVALID"))).toBe("warn");
  });

  it("follows an overridden status and logs each error once", () => {
    const outage = standardRailError("PROVIDER_QUOTE_REJECTED", { status: 503 });
    logStandardRailError(outage);
    logStandardRailError(outage);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
