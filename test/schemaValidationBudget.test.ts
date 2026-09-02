import { describe, expect, it } from "vitest";
import {
  assertSchema,
  compileClosedRequestSchema,
  RequestSchemaError,
  SCHEMA_VALIDATION_BUDGET_MS,
  SchemaValidationBudgetError,
} from "../src/standardRail/schema.js";

function stringSchema(field: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: { q: { type: "string", ...field } },
  };
}

describe("provider schema patterns", () => {
  it("accepts the patterns real provider cards publish when maxLength bounds them", () => {
    expect(() => compileClosedRequestSchema(stringSchema({
      pattern: "^0x[0-9a-fA-F]{40}$", maxLength: 4_096,
    }))).not.toThrow();
    expect(() => compileClosedRequestSchema(stringSchema({
      pattern: "^(?![A-Za-z]{2}-[A-Za-z0-9]{1,3}$).+$", minLength: 1, maxLength: 64,
    }))).not.toThrow();
    expect(() => compileClosedRequestSchema(stringSchema({
      pattern: "^(?:[a-z0-9]+-)*[a-z0-9]+$", maxLength: 128,
    }))).not.toThrow();
  });

  it("requires a bounded maxLength beside every pattern", () => {
    expect(() => compileClosedRequestSchema(stringSchema({ pattern: "^[a-z]+$" })))
      .toThrow(/requires maxLength/);
    expect(() => compileClosedRequestSchema(stringSchema({ pattern: "^[a-z]+$", maxLength: 10_000 })))
      .toThrow(/requires maxLength/);
  });

  it("rejects back-references, invalid syntax, oversized sources and patterns on non-strings", () => {
    expect(() => compileClosedRequestSchema(stringSchema({ pattern: "^(a)\\1$", maxLength: 8 })))
      .toThrow(/unsupported pattern/);
    expect(() => compileClosedRequestSchema(stringSchema({ pattern: "^(?<x>a)\\k<x>$", maxLength: 8 })))
      .toThrow(/unsupported pattern/);
    expect(() => compileClosedRequestSchema(stringSchema({ pattern: "^(a$", maxLength: 8 })))
      .toThrow(/unsupported pattern/);
    expect(() => compileClosedRequestSchema(stringSchema({ pattern: "a".repeat(513), maxLength: 8 })))
      .toThrow(/unsupported pattern/);
    expect(() => compileClosedRequestSchema({
      type: "object",
      additionalProperties: false,
      properties: { n: { type: "integer", pattern: "^1$" } },
    })).toThrow(/pattern on a non-string/);
  });

  it("aborts a catastrophic pattern at the CPU budget and withdraws nothing else", () => {
    const validate = compileClosedRequestSchema(stringSchema({ pattern: "^(a+)+$", maxLength: 64 }));
    expect(() => assertSchema(validate, { q: "aaaa" })).not.toThrow();
    const started = Date.now();
    expect(() => assertSchema(validate, { q: `${"a".repeat(40)}b` }))
      .toThrow(SchemaValidationBudgetError);
    expect(Date.now() - started).toBeLessThan(SCHEMA_VALIDATION_BUDGET_MS * 20);
    // The isolate is intact afterwards: ordinary validation still works.
    expect(() => assertSchema(validate, { q: "aa" })).not.toThrow();
    expect(() => assertSchema(validate, { q: "b" })).toThrow(RequestSchemaError);
  });
});
