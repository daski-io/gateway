import { describe, expect, it } from "vitest";
import {
  assertBoundedJsonValue,
  REQUEST_JSON_BUDGET,
} from "../src/standardRail/jsonBounds.js";
import {
  assertNoDuplicateJsonKeys,
  canonicalJson,
} from "../src/standardRail/canonical.js";
import {
  assertSchema,
  compileClosedRequestSchema,
} from "../src/standardRail/schema.js";

const nested = (depth: number): unknown => (depth === 0 ? 1 : { a: nested(depth - 1) });

describe("bounded json instance budget", () => {
  it("accepts realistic nested supplier form data", () => {
    const value = {
      formData: {
        "member.0.address": { line1: "1 Main St", city: "Cheyenne", state: "WY", postal: "82001" },
        "member.0.name": "Ada",
        shares: [{ class: "A", count: 100 }],
      },
    };
    expect(() => assertBoundedJsonValue(value, REQUEST_JSON_BUDGET, "Request")).not.toThrow();
  });

  it("rejects values nested beyond the depth budget", () => {
    expect(() => assertBoundedJsonValue(nested(30), REQUEST_JSON_BUDGET, "Request"))
      .toThrow(/too deeply nested/);
  });

  it("applies one cumulative node budget across sibling subtrees", () => {
    const half = Array.from({ length: 17_000 }, (_, index) => index);
    expect(() => assertBoundedJsonValue({ a: half, b: half }, REQUEST_JSON_BUDGET, "Request"))
      .toThrow(/too many values/);
  });

  it("rejects unsafe keys anywhere in the value", () => {
    const value = { formData: JSON.parse('{"__proto__": {"x": 1}}') as unknown };
    expect(() => assertBoundedJsonValue(value, REQUEST_JSON_BUDGET, "Request"))
      .toThrow(/unsafe key/);
  });

  it("rejects oversized keys and non-finite numbers", () => {
    expect(() => assertBoundedJsonValue({ ["k".repeat(200)]: 1 }, REQUEST_JSON_BUDGET, "Request"))
      .toThrow(/key too long/);
    expect(() => assertBoundedJsonValue({ a: Number.POSITIVE_INFINITY }, REQUEST_JSON_BUDGET, "Request"))
      .toThrow(/non-finite/);
  });
});

describe("bounded dynamic record schema form", () => {
  const record = {
    type: "object",
    properties: {},
    additionalProperties: true,
    maxProperties: 96,
    propertyNames: { maxLength: 128 },
  };
  const request = (formData: unknown) => ({
    type: "object",
    properties: { formData },
    required: ["formData"],
    additionalProperties: false,
  } as Record<string, unknown>);

  it("accepts a bounded record with pinned key bounds", () => {
    expect(() => compileClosedRequestSchema(request(record))).not.toThrow();
  });

  it("rejects a record without propertyNames bounds", () => {
    const { propertyNames: _propertyNames, ...bare } = record;
    expect(() => compileClosedRequestSchema(request(bare)))
      .toThrow(/bounded dynamic record/);
  });

  it("rejects a record without a key-count bound", () => {
    const { maxProperties: _maxProperties, ...bare } = record;
    expect(() => compileClosedRequestSchema(request(bare)))
      .toThrow(/bounded dynamic record/);
  });

  it("rejects a dynamic record at the schema root", () => {
    expect(() => compileClosedRequestSchema(record as Record<string, unknown>))
      .toThrow(/at the root/);
  });

  it("rejects propertyNames outside a dynamic record", () => {
    const schema = {
      ...request({ type: "string" }),
      propertyNames: { maxLength: 4 },
    };
    expect(() => compileClosedRequestSchema(schema)).toThrow(/propertyNames/);
  });

  it("bounds record values through the runtime budget", () => {
    const validate = compileClosedRequestSchema(request(record));
    expect(() => assertSchema(validate, { formData: { any: { nested: ["ok", 1] } } }))
      .not.toThrow();
    expect(() => assertSchema(validate, { formData: nested(30) }))
      .toThrow(/too deeply nested/);
    expect(() => assertSchema(validate, { formData: JSON.parse('{"__proto__": 1}') }))
      .toThrow(/unsafe key/);
  });
});

describe("canonical json backstop", () => {
  it("rejects unsafe keys", () => {
    expect(() => canonicalJson(JSON.parse('{"constructor": 1}'))).toThrow(/unsafe key/);
  });

  it("rejects depth beyond the canonical limit", () => {
    expect(() => canonicalJson(nested(70))).toThrow(/too deeply nested/);
  });
});

describe("ingress json scanner belt", () => {
  it("still rejects duplicate keys", () => {
    expect(() => assertNoDuplicateJsonKeys('{"a":1,"a":2}')).toThrow(/Duplicate/);
  });

  it("rejects unsafe keys at the parse boundary", () => {
    expect(() => assertNoDuplicateJsonKeys('{"__proto__":{}}')).toThrow(/unsafe key/);
  });

  it("rejects deep nesting at the parse boundary", () => {
    expect(() => assertNoDuplicateJsonKeys(`${"[".repeat(80)}1${"]".repeat(80)}`))
      .toThrow(/too deeply nested/);
  });

  it("rejects oversized keys at the parse boundary", () => {
    expect(() => assertNoDuplicateJsonKeys(`{"${"k".repeat(300)}":1}`))
      .toThrow(/key is too long/);
  });

  it("accepts ordinary nested payloads", () => {
    expect(() => assertNoDuplicateJsonKeys(JSON.stringify({ a: { b: [1, 2, { c: "d" }] } })))
      .not.toThrow();
  });
});
