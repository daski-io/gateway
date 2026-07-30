import { describe, expect, it } from "vitest";
import {
  buyerNameMismatchWarning,
  mcpJson,
  phoneWhoisWarnings,
} from "../src/mcp/util.js";

// De-scar 260726: the acknowledgement gates (phone token/object, buyer
// name) and the principalUpdate composer are gone. The platform informs —
// consequential fields are named in quote `warnings` while they can still
// be corrected, without copying their values into durable challenge JSON.
describe("informational warnings", () => {
  it("phone values produce one WHOIS-consequence warning", () => {
    const w = phoneWhoisWarnings({
      registrantPhone: "+15125550142",
      domain: "x.xyz",
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("registrantPhone");
    expect(w[0]).not.toContain("+15125550142");
    expect(w[0]).toContain("public WHOIS");
  });

  it("no phone fields, no warning", () => {
    expect(phoneWhoisWarnings({ domain: "x.xyz" })).toHaveLength(0);
  });

  it("a diverging permanent buyer name warns against the companyName", () => {
    const w = buyerNameMismatchWarning("Harbor and Pine Goods", {
      companyName: "Sunrise Trading LLC",
    });
    expect(w).toContain("companyName");
    expect(w).not.toContain("Harbor and Pine Goods");
    expect(w).not.toContain("Sunrise Trading LLC");
    expect(w).toContain("permanently");
  });

  it("a loose match (case/punctuation/prefix) does not warn", () => {
    expect(
      buyerNameMismatchWarning("Example Studio", {
        companyName: "Example Studio LLC",
      }),
    ).toBeNull();
  });

  it("no stated organization in the request, no warning", () => {
    expect(
      buyerNameMismatchWarning("buyer-aa39aa", { domain: "x.xyz" }),
    ).toBeNull();
  });

  it("registrantOrganization (domain purchases) is probed too", () => {
    const w = buyerNameMismatchWarning("buyer-0b83e2", {
      domain: "x.xyz",
      registrantOrganization: "Sunrise Trading LLC",
    });
    expect(w).toContain("registrantOrganization");
    expect(w).not.toContain("buyer-0b83e2");
    expect(w).not.toContain("Sunrise Trading LLC");
  });

  it("a fully non-alphanumeric organization still warns (no vacuous match)", () => {
    expect(
      buyerNameMismatchWarning("buyer-aa39aa", { companyName: "株式会社" }),
    ).not.toBeNull();
  });
});

describe("structured tool output", () => {
  it("mcpJson mirrors the payload into structuredContent", () => {
    const result = mcpJson({ status: "completed", a: 1 });
    expect(result.structuredContent).toEqual({ status: "completed", a: 1 });
  });
});

// De-scar 260726: the "principal update composition" suite is gone with
// buildPrincipalUpdate itself. Provider facts (emailDelivery,
// publicResolutionVerified, …) flow through `artifacts` untouched — how
// they are phrased to the principal is the agent's own business.
