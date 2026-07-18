import { describe, expect, it } from "vitest";
import {
  checkPhoneConfirmation,
  expectedPhoneConfirmationToken,
} from "../src/mcp/util.js";

// The phone confirmation gate: a plan-building call carrying phone fields
// fails with PHONE_CONFIRMATION_REQUIRED and a token bound to the exact
// values; the same call with the token passes; changing any value
// invalidates the token.

const ARGS = {
  domain: "example.xyz",
  registrantPhone: "+48221234567",
};

describe("phone confirmation gate", () => {
  it("passes untouched when no phone field is present", () => {
    expect(checkPhoneConfirmation({ domain: "example.xyz" }, undefined)).toBeNull();
  });

  it("rejects a phone-bearing call without a token, exposing the token and values", () => {
    const err = checkPhoneConfirmation(ARGS, undefined);
    expect(err).not.toBeNull();
    const payload = JSON.parse(err!.content[0]!.type === "text" ? (err!.content[0] as { text: string }).text : "{}");
    expect(payload.code).toBe("PHONE_CONFIRMATION_REQUIRED");
    expect(payload.details.phones.registrantPhone).toBe("+48221234567");
    expect(payload.details.confirmationToken).toBe(
      expectedPhoneConfirmationToken([
        { field: "registrantPhone", value: "+48221234567" },
      ]),
    );
    expect(payload.message).toContain("confirm or correct");
  });

  it("passes with the bound token", () => {
    const token = expectedPhoneConfirmationToken([
      { field: "registrantPhone", value: "+48221234567" },
    ]);
    expect(checkPhoneConfirmation(ARGS, token)).toBeNull();
  });

  it("re-requires confirmation when a phone value changes", () => {
    const token = expectedPhoneConfirmationToken([
      { field: "registrantPhone", value: "+48221234567" },
    ]);
    const err = checkPhoneConfirmation(
      { ...ARGS, registrantPhone: "+48221234568" },
      token,
    );
    expect(err).not.toBeNull();
  });

  it("binds every phone field present, not just the first", () => {
    const args = { ...ARGS, adminPhone: "+15555550100" };
    const single = expectedPhoneConfirmationToken([
      { field: "registrantPhone", value: "+48221234567" },
    ]);
    expect(checkPhoneConfirmation(args, single)).not.toBeNull();
    const both = expectedPhoneConfirmationToken([
      { field: "registrantPhone", value: "+48221234567" },
      { field: "adminPhone", value: "+15555550100" },
    ]);
    expect(checkPhoneConfirmation(args, both)).toBeNull();
  });
});
