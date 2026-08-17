import { describe, expect, it } from "vitest";
import { hasRequiredConfirmations } from "../src/standardRail/finality.js";

describe("standard-rail finality", () => {
  it("counts the mined block as the first confirmation", () => {
    expect(hasRequiredConfirmations(100n, 100n, 1)).toBe(true);
    expect(hasRequiredConfirmations(101n, 100n, 2)).toBe(true);
    expect(hasRequiredConfirmations(100n, 100n, 2)).toBe(false);
  });

  it("rejects invalid confirmation counts", () => {
    expect(() => hasRequiredConfirmations(100n, 100n, 0)).toThrow(
      "Required confirmations must be a positive integer",
    );
  });
});
