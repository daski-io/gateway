import { describe, it, expect } from "vitest";
import { findUnknownServiceArgKeys } from "../src/mcp/util.js";

// Unknown-key detection behind the buy_service `warnings` field. Must be
// conservative: contact containers, dotted-field prefixes, and legacy
// aliases are all legitimate — only genuinely unconsumed keys may warn
// (observed incident: `displayName` silently dropped by create-mailbox).

const REQUIRED = ["domain", "registrantName", "registrantEmail"];
const OPTIONAL = ["term", "whoisPrivacy"];

describe("findUnknownServiceArgKeys", () => {
  it("flags keys no advertised field consumes", () => {
    expect(
      findUnknownServiceArgKeys(
        { domain: "x.info", displayName: "Meadowlane Office" },
        REQUIRED,
        OPTIONAL,
      ),
    ).toEqual(["displayName"]);
  });

  it("accepts required, optional, alias, and contact-container keys", () => {
    expect(
      findUnknownServiceArgKeys(
        {
          domain: "x.info",
          registrantName: "Ola",
          term: 1,
          years: 1, // legacy alias
          whoisPrivacy: true,
          registrant: { firstName: "Ola" }, // nested contact shape
          admin: {},
        },
        REQUIRED,
        OPTIONAL,
      ),
    ).toEqual([]);
  });

  it("whitelists the container of dotted field names", () => {
    expect(
      findUnknownServiceArgKeys(
        { mailbox: { password: "x" } },
        ["mailbox.password"],
        [],
      ),
    ).toEqual([]);
  });

  it("handles missing args and empty field lists", () => {
    expect(findUnknownServiceArgKeys(undefined, REQUIRED, OPTIONAL)).toEqual([]);
    expect(findUnknownServiceArgKeys({ stray: 1 }, [], [])).toEqual(["stray"]);
  });
});
