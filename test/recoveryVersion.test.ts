import { describe, expect, it } from "vitest";
import { supportsOrderRecoveries } from "../src/marketplace/recoveryVersion.js";

describe("order recovery version gate", () => {
  it("reads recoveries from implementation 2.2.0 on, comparing numerically", () => {
    for (const version of ["2.2.0", "2.2.1", "2.3.0", "2.10.0", "3.0.0", "10.0.0"]) {
      expect(supportsOrderRecoveries(version), version).toBe(true);
    }
  });

  it("reports none before 2.2.0", () => {
    for (const version of ["2.1.0", "2.1.99", "2.0.10", "1.99.99", "0.0.0"]) {
      expect(supportsOrderRecoveries(version), version).toBe(false);
    }
  });

  it("treats a malformed or missing version as unsupported", () => {
    for (const version of [
      "",
      "2.2",
      "2.2.0.0",
      "v2.2.0",
      "2.2.0-rc.1",
      "2.2.0+build",
      " 2.2.0",
      "2.2.0\n",
      "02.2.0",
      "2.02.0",
      "2.2.x",
      "9999999999.0.0",
    ]) {
      expect(supportsOrderRecoveries(version), JSON.stringify(version)).toBe(false);
    }
    for (const version of [undefined, null, 220, 2n, {}, ["2.2.0"]]) {
      expect(supportsOrderRecoveries(version), String(version)).toBe(false);
    }
  });
});
