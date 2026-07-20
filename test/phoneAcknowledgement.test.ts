import { describe, expect, it } from "vitest";
import {
  checkPhoneAcknowledgement,
  expectedPhoneAcknowledgementToken,
} from "../src/mcp/util.js";

// The phone acknowledgement gate: a call carrying phone fields fails with
// PHONE_ACKNOWLEDGEMENT_REQUIRED and a token bound to the exact
// values; the same call with the token passes; changing any value
// invalidates the token.

const ARGS = {
  domain: "example.xyz",
  registrantPhone: "+48221234567",
};

describe("phone acknowledgement gate", () => {
  it("passes untouched when no phone field is present", () => {
    expect(checkPhoneAcknowledgement({ domain: "example.xyz" }, undefined)).toBeNull();
  });

  it("rejects a phone-bearing call without a token, exposing the token and values", () => {
    const err = checkPhoneAcknowledgement(ARGS, undefined);
    expect(err).not.toBeNull();
    const payload = JSON.parse(err!.content[0]!.type === "text" ? (err!.content[0] as { text: string }).text : "{}");
    expect(payload.code).toBe("PHONE_ACKNOWLEDGEMENT_REQUIRED");
    expect(payload.details.phones.registrantPhone).toBe("+48221234567");
    expect(payload.details.phoneAcknowledgementToken).toBe(
      expectedPhoneAcknowledgementToken([
        { field: "registrantPhone", value: "+48221234567" },
      ]),
    );
    expect(payload.message).toContain("confirm or correct");
  });

  it("passes with the bound token", () => {
    const token = expectedPhoneAcknowledgementToken([
      { field: "registrantPhone", value: "+48221234567" },
    ]);
    expect(checkPhoneAcknowledgement(ARGS, token)).toBeNull();
  });

  it("re-requires confirmation when a phone value changes", () => {
    const token = expectedPhoneAcknowledgementToken([
      { field: "registrantPhone", value: "+48221234567" },
    ]);
    const err = checkPhoneAcknowledgement(
      { ...ARGS, registrantPhone: "+48221234568" },
      token,
    );
    expect(err).not.toBeNull();
  });

  it("binds every phone field present, not just the first", () => {
    const args = { ...ARGS, adminPhone: "+15555550100" };
    const single = expectedPhoneAcknowledgementToken([
      { field: "registrantPhone", value: "+48221234567" },
    ]);
    expect(checkPhoneAcknowledgement(args, single)).not.toBeNull();
    const both = expectedPhoneAcknowledgementToken([
      { field: "registrantPhone", value: "+48221234567" },
      { field: "adminPhone", value: "+15555550100" },
    ]);
    expect(checkPhoneAcknowledgement(args, both)).toBeNull();
  });
});
