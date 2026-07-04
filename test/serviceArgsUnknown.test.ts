import { describe, it, expect } from "vitest";
import {
  findUnknownServiceArgKeys,
  validateAndNormalizeServiceArgs,
} from "../src/mcp/util.js";

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

// missing_fields must tell agents whether a value was absent or sent blank,
// and steer subdivision gaps toward the city-name convention instead of a
// fabricated province (observed: empty registrantState → invented value).
describe("validateAndNormalizeServiceArgs empty-vs-absent", () => {
  const required = ["domain", "registrantState"];

  it("separates emptyFields from missingFields and hints on subdivisions", () => {
    const r = validateAndNormalizeServiceArgs(
      { domain: "x.info", registrantState: "" },
      required,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const payload = JSON.parse(r.error.content[0].text) as {
      details: { missingFields: string[]; emptyFields: string[]; hint?: string };
      next_action: string;
    };
    expect(payload.details.missingFields).toEqual(["registrantState"]);
    expect(payload.details.emptyFields).toEqual(["registrantState"]);
    expect(payload.details.hint).toMatch(/re-use the city name/i);
    expect(payload.next_action).toMatch(/do not fabricate/i);
  });

  it("absent fields carry no emptyFields entry and the generic next_action", () => {
    const r = validateAndNormalizeServiceArgs({ registrantState: "CO" }, required);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const payload = JSON.parse(r.error.content[0].text) as {
      details: { missingFields: string[]; emptyFields: string[] };
    };
    expect(payload.details.missingFields).toEqual(["domain"]);
    expect(payload.details.emptyFields).toEqual([]);
  });
});
