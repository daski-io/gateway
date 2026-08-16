import { describe, expect, it, vi } from "vitest";
import {
  advertisesExactEip3009,
  createPinnedLookup,
} from "../src/standardRail/facilitator.js";

describe("standard facilitator capabilities", () => {
  it("accepts the generic exact rail returned by CDP", () => {
    expect(advertisesExactEip3009({
      kinds: [{ network: "eip155:84532", scheme: "exact", x402Version: 2 }],
      extensions: [],
      signers: {},
    }, "eip155:84532")).toBe(true);
  });

  it("accepts an explicitly advertised EIP-3009 rail", () => {
    expect(advertisesExactEip3009({
      kinds: [{
        network: "eip155:84532",
        scheme: "exact",
        x402Version: 2,
        extra: { assetTransferMethod: "eip3009" },
      }],
      extensions: [],
      signers: {},
    }, "eip155:84532")).toBe(true);
  });

  it("rejects a rail that only advertises another transfer method", () => {
    expect(advertisesExactEip3009({
      kinds: [{
        network: "eip155:84532",
        scheme: "exact",
        x402Version: 2,
        extra: { assetTransferMethod: "permit2" },
      }],
      extensions: [],
      signers: {},
    }, "eip155:84532")).toBe(false);
  });
});

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
