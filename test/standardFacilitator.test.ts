import { describe, expect, it, vi } from "vitest";
import { createPinnedLookup } from "../src/standardRail/facilitator.js";

describe("standard facilitator DNS pinning", () => {
  it("returns an address array when Node requests all lookup results", () => {
    const callback = vi.fn();
    createPinnedLookup({ address: "203.0.113.10", family: 4 })(
      "facilitator.example",
      { all: true },
      callback,
    );
    expect(callback).toHaveBeenCalledWith(null, [{ address: "203.0.113.10", family: 4 }]);
  });

  it("returns the pinned scalar address for a conventional lookup", () => {
    const callback = vi.fn();
    createPinnedLookup({ address: "2001:db8::10", family: 6 })(
      "facilitator.example",
      { all: false },
      callback,
    );
    expect(callback).toHaveBeenCalledWith(null, "2001:db8::10", 6);
  });
});
