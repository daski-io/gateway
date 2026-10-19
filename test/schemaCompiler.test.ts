import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  assertSchema,
  compileClosedRequestSchema,
  compileClosedResponseSchema,
  RequestSchemaError,
  SchemaCompiler,
  schemaCompilerStats,
} from "../src/standardRail/schema.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const AJV_OPTIONS = { allErrors: true, strict: true };

// A provider card's skill schemas as the card serves them. Every catalog
// refresh parses this text again, so each refresh hands the compiler new
// objects with the same content.
const CARD_TEXT = JSON.stringify({
  request: {
    type: "object",
    additionalProperties: false,
    required: ["name", "entityType"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9 .,&-]+$" },
      entityType: { type: "string", enum: ["LLC", "CORP"] },
      address: {
        type: "object",
        additionalProperties: false,
        required: ["line1"],
        properties: {
          line1: { type: "string", maxLength: 128 },
          postalCode: { type: "string", maxLength: 10, pattern: "^[0-9]{5}(?:-[0-9]{4})?$" },
        },
      },
      members: { type: "array", maxItems: 4, items: { type: "string", maxLength: 32 } },
      formData: {
        type: "object",
        additionalProperties: true,
        properties: {},
        maxProperties: 8,
        propertyNames: { maxLength: 32 },
      },
    },
  },
  result: {
    $schema: DRAFT_2020_12,
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["completed", "failed"] },
      reference: { type: "string", maxLength: 32, pattern: "^ref-[a-z0-9]+$" },
    },
  },
});

function parseCard(): { request: Record<string, unknown>; result: Record<string, unknown> } {
  return JSON.parse(CARD_TEXT) as { request: Record<string, unknown>; result: Record<string, unknown> };
}

function scopeValues(ajv: Ajv): number {
  return Object.values(ajv.scope.get()).reduce((total, values) => total + (values?.length ?? 0), 0);
}

function requestError(run: () => void): RequestSchemaError {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestSchemaError) return error;
    throw error;
  }
  throw new Error("expected a RequestSchemaError");
}

function stringField(maxLength: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: { q: { type: "string", maxLength } },
  };
}

const REQUESTS: unknown[] = [
  { name: "Acme Holdings", entityType: "LLC" },
  { name: "Acme Holdings", entityType: "LLC", address: { line1: "1 Main St", postalCode: "12345-6789" } },
  { name: "Acme Holdings", entityType: "LLC", members: ["a", "b"], formData: { anything: { nested: [1] } } },
  {},
  { name: "", entityType: "LP" },
  { name: "Acme <script>", entityType: "CORP", extra: true },
  { name: "Acme", entityType: "LLC", address: { postalCode: "1234" } },
  { name: "Acme", entityType: "LLC", members: ["a", "b", "c", "d", "e"] },
  { name: 7, entityType: ["LLC"], address: "1 Main St", members: [1] },
];

const RESULTS: unknown[] = [
  { status: "completed" },
  { status: "failed", reference: "ref-123" },
  { status: "pending" },
  { status: "completed", reference: "REF-1", extra: 1 },
  {},
];

describe("schema compilation across catalog refreshes", () => {
  it("shows the retention it bounds: a plain Ajv instance keeps every parsed copy", () => {
    const ajv = new Ajv(AJV_OPTIONS);
    ajv.compile(parseCard().request);
    const once = scopeValues(ajv);
    ajv.compile(parseCard().request);
    expect(scopeValues(ajv)).toBeGreaterThan(once);
  });

  it("reuses one validator for every freshly parsed copy and never grows its cache or Ajv's state", () => {
    const card = parseCard();
    const validateRequest = compileClosedRequestSchema(card.request);
    const validateResult = compileClosedResponseSchema(card.result);
    const settled = schemaCompilerStats();
    expect(settled["draft-07"].validators).toBeGreaterThan(0);
    expect(settled["2020-12"].validators).toBeGreaterThan(0);

    for (let refresh = 0; refresh < 250; refresh += 1) {
      const copy = parseCard();
      expect(compileClosedRequestSchema(copy.request)).toBe(validateRequest);
      expect(compileClosedResponseSchema(copy.result)).toBe(validateResult);
    }

    expect(schemaCompilerStats()).toEqual(settled);
  });

  it("validates through a reused validator exactly as a fresh compilation does", () => {
    const freshRequest = new Ajv(AJV_OPTIONS).compile(parseCard().request);
    const freshResult = new Ajv2020(AJV_OPTIONS).compile(parseCard().result);
    for (const value of REQUESTS) {
      const reused = compileClosedRequestSchema(parseCard().request);
      expect(reused(value)).toBe(freshRequest(value));
      expect(reused.errors).toEqual(freshRequest.errors);
    }
    for (const value of RESULTS) {
      const reused = compileClosedResponseSchema(parseCard().result);
      expect(reused(value)).toBe(freshResult(value));
      expect(reused.errors).toEqual(freshResult.errors);
    }
  });

  it("answers every caller of a shared validator with the errors of its own value", () => {
    const first = compileClosedRequestSchema(parseCard().request);
    const second = compileClosedRequestSchema(parseCard().request);
    expect(second).toBe(first);

    const missing = requestError(() => assertSchema(first, { name: "Acme" }));
    const enumMiss = requestError(() => assertSchema(second, { name: "Acme", entityType: "LP" }));
    expect(missing.details).toEqual([
      { path: "$", keyword: "required", message: "must have required property 'entityType'" },
    ]);
    expect(enumMiss.details).toEqual([{
      path: "/entityType", keyword: "enum", message: "must be equal to one of the allowed values",
      allowedValues: ["LLC", "CORP"],
    }]);
    expect(() => assertSchema(first, { name: "Acme", entityType: "CORP" })).not.toThrow();
  });

  it("compiles each distinct schema separately, in its own key order", () => {
    const declared = {
      type: "object", additionalProperties: false,
      properties: { a: { type: "string" }, b: { type: "string" } },
    };
    const reordered = {
      type: "object", additionalProperties: false,
      properties: { b: { type: "string" }, a: { type: "string" } },
    };
    const validateDeclared = compileClosedRequestSchema(declared);
    const validateReordered = compileClosedRequestSchema(reordered);
    expect(validateReordered).not.toBe(validateDeclared);
    // Ajv reports property errors in schema key order; each schema keeps its own.
    expect(requestError(() => assertSchema(validateDeclared, { a: 1, b: 1 })).details.map((d) => d.path))
      .toEqual(["/a", "/b"]);
    expect(requestError(() => assertSchema(validateReordered, { a: 1, b: 1 })).details.map((d) => d.path))
      .toEqual(["/b", "/a"]);

    const short = compileClosedRequestSchema(stringField(2));
    const long = compileClosedRequestSchema(stringField(3));
    expect(long).not.toBe(short);
    expect(short({ q: "abc" })).toBe(false);
    expect(long({ q: "abc" })).toBe(true);
  });

  it("compiles from a private copy, so no caller can change a validator another caller holds", () => {
    // Ajv's generated code reads a long enum from the compiled schema object at validation time.
    const values = Array.from({ length: 250 }, (_, index) => `value-${index}`);
    const enumField = () => ({
      type: "object", additionalProperties: false,
      properties: { q: { type: "string", enum: [...values] } },
    });
    const schema = enumField();
    const validate = compileClosedRequestSchema(schema);
    schema.properties.q.enum.push("injected");
    expect(validate({ q: "injected" })).toBe(false);
    expect(compileClosedRequestSchema(enumField())).toBe(validate);
    // The changed schema is a different schema, compiled on its own.
    expect(compileClosedRequestSchema(schema)({ q: "injected" })).toBe(true);
  });

  it("rejects what it rejected before on every attempt and caches no rejection", () => {
    const unknownKeyword = {
      type: "object", additionalProperties: false,
      properties: { q: { type: "string", maxLength: 4, unknownKeyword: true } },
    };
    const before = schemaCompilerStats()["draft-07"];
    expect(() => compileClosedRequestSchema(structuredClone(unknownKeyword))).toThrow(/unknown keyword/);
    expect(() => compileClosedRequestSchema(structuredClone(unknownKeyword))).toThrow(/unknown keyword/);
    const after = schemaCompilerStats()["draft-07"];
    expect(after.validators).toBe(before.validators);
    // Each attempt counts toward replacing the instance: Ajv keeps state from a rejection too.
    expect(after.compiled).toBe(before.compiled + 2);

    // The gateway's own closed-schema rules still run first, on every call.
    const open = { type: "object", properties: { q: { type: "string" } } };
    expect(() => compileClosedRequestSchema(open)).toThrow(/must close object/);
    expect(() => compileClosedRequestSchema(structuredClone(open))).toThrow(/must close object/);
    const patterned = {
      type: "object", additionalProperties: false,
      properties: { q: { type: "string", pattern: "^(a)\\1$", maxLength: 8 } },
    };
    expect(() => compileClosedRequestSchema(patterned)).toThrow(/unsupported pattern/);
    expect(() => compileClosedRequestSchema(structuredClone(patterned))).toThrow(/unsupported pattern/);
    expect(schemaCompilerStats()["draft-07"].compiled).toBe(after.compiled);
  });

  it("compiles a schema that is not plain JSON data on its own, without caching it", () => {
    const withUndefined = {
      type: "object", additionalProperties: false,
      properties: { q: { type: "string", maxLength: 2, description: undefined } },
    };
    const before = schemaCompilerStats();
    const first = compileClosedRequestSchema(withUndefined);
    const second = compileClosedRequestSchema(withUndefined);
    expect(second).not.toBe(first);
    expect(first({ q: "ab" })).toBe(true);
    expect(first({ q: "abc" })).toBe(false);
    expect(schemaCompilerStats()).toEqual(before);
  });
});

describe("SchemaCompiler limits", () => {
  const draft07 = () => new Ajv(AJV_OPTIONS);

  it("replaces its Ajv instance after its schema limit and keeps earlier validators working", () => {
    const compiler = new SchemaCompiler(draft07, { maxSchemas: 2, maxTextLength: 1_000_000 });
    const one = compiler.compile(stringField(1));
    const two = compiler.compile(stringField(2));
    expect(compiler.compile(stringField(1))).toBe(one);
    expect(compiler.stats()).toMatchObject({ generation: 0, validators: 2, compiled: 2 });

    const three = compiler.compile(stringField(3));
    expect(compiler.stats()).toMatchObject({ generation: 1, validators: 1, compiled: 1 });
    expect(one({ q: "a" })).toBe(true);
    expect(one({ q: "ab" })).toBe(false);
    expect(two({ q: "ab" })).toBe(true);
    expect(three({ q: "abc" })).toBe(true);
    expect(three({ q: "abcd" })).toBe(false);

    // The new instance starts empty: the first schema compiles again there.
    const oneAgain = compiler.compile(stringField(1));
    expect(oneAgain).not.toBe(one);
    expect(oneAgain({ q: "ab" })).toBe(false);
    expect(compiler.stats()).toMatchObject({ generation: 1, validators: 2, compiled: 2 });
  });

  it("replaces its Ajv instance once the schema text reaches its limit", () => {
    const length = JSON.stringify(stringField(1)).length;
    const compiler = new SchemaCompiler(draft07, { maxSchemas: 100, maxTextLength: length * 2 });
    compiler.compile(stringField(1));
    compiler.compile(stringField(2));
    expect(compiler.stats()).toMatchObject({ generation: 0, validators: 2, textLength: length * 2 });
    compiler.compile(stringField(3));
    expect(compiler.stats()).toMatchObject({ generation: 1, validators: 1, textLength: length });
  });

  it("counts rejected schemas toward the limit, so repeated rejections cannot grow an instance", () => {
    const compiler = new SchemaCompiler(draft07, { maxSchemas: 2, maxTextLength: 1_000_000 });
    const rejected = { type: "object", additionalProperties: false, properties: { q: { type: "string", unknownKeyword: 1 } } };
    expect(() => compiler.compile(rejected)).toThrow(/unknown keyword/);
    expect(() => compiler.compile(rejected)).toThrow(/unknown keyword/);
    expect(compiler.stats()).toMatchObject({ generation: 0, validators: 0, compiled: 2 });
    expect(() => compiler.compile(rejected)).toThrow(/unknown keyword/);
    expect(compiler.stats()).toMatchObject({ generation: 1, validators: 0, compiled: 1 });
  });

  it("holds Ajv's state to one full instance while distinct schemas keep arriving", () => {
    const limits = { maxSchemas: 8, maxTextLength: 1_000_000 };
    const full = new SchemaCompiler(draft07, limits);
    for (let index = 1; index <= 8; index += 1) full.compile(stringField(index));

    const compiler = new SchemaCompiler(draft07, limits);
    let peak = 0;
    for (let index = 1; index <= 100; index += 1) {
      const validate = compiler.compile(stringField(index));
      expect(validate({ q: "x".repeat(index) })).toBe(true);
      expect(validate({ q: "x".repeat(index + 1) })).toBe(false);
      peak = Math.max(peak, compiler.stats().scopeValues);
    }
    expect(compiler.stats()).toMatchObject({ generation: 12, validators: 4, compiled: 4 });
    expect(peak).toBe(full.stats().scopeValues);
  });
});
