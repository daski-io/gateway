import vm from "node:vm";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import {
  assertBoundedJsonValue,
  REQUEST_JSON_BUDGET,
  RESPONSE_JSON_BUDGET,
} from "./jsonBounds.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const ajv2020 = new Ajv2020({ allErrors: true, strict: true });
const UNSAFE_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const RECORD_REQUIRED_KEYS = [
  "type", "properties", "additionalProperties", "maxProperties", "propertyNames",
] as const;
const RECORD_ALLOWED_KEYS = new Set<string>([
  ...RECORD_REQUIRED_KEYS, "minProperties", "description",
]);

/** A `pattern` may only guard a string whose length the schema itself bounds. */
const PATTERN_MAX_LENGTH = 4_096;
const PATTERN_SOURCE_MAX_LENGTH = 512;
/**
 * One schema validation may hold the event loop this long. Provider schemas
 * reach V8's backtracking regex engine through `pattern`, so a hostile
 * pattern could otherwise pin the process from the unauthenticated purchase
 * path; a validation that overruns is aborted and the listing is withdrawn.
 */
export const SCHEMA_VALIDATION_BUDGET_MS = 100;

export class SchemaValidationBudgetError extends Error {
  constructor(label: string) {
    super(`${label} schema validation exceeded its CPU budget`);
    this.name = "SchemaValidationBudgetError";
  }
}

// Static shape check for a provider-supplied `pattern`. Anything the `u`-mode
// engine rejects is rejected here, the source is bounded, and back-references
// (the one construct with no linear-time evaluation at all) are refused. The
// runtime budget in `assertSchema` is the control for everything else: a
// syntactic ReDoS detector would reject legitimate delimiter patterns such as
// `^(?:[a-z0-9]+-)*[a-z0-9]+$` while still missing polynomial blow-ups.
export function assertSafePattern(pattern: unknown, label: string, path: string): void {
  const invalid: () => never = () => {
    throw new Error(`Outcome ${label} schema has an unsupported pattern at ${path}`);
  };
  if (
    typeof pattern !== "string" || pattern.length === 0 ||
    pattern.length > PATTERN_SOURCE_MAX_LENGTH
  ) invalid();
  const source: string = pattern;
  try {
    new RegExp(source, "u");
  } catch {
    invalid();
  }
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "\\") {
      const next = source[index + 1] ?? "";
      if ((!inClass && /[1-9]/.test(next)) || next === "k") invalid();
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
    }
  }
}

function assertBoundedPatternedString(
  current: Record<string, unknown>,
  label: string,
  path: string,
): void {
  if (!("pattern" in current)) return;
  assertSafePattern(current.pattern, label, path);
  const maxLength = current.maxLength;
  if (
    !Number.isSafeInteger(maxLength) ||
    (maxLength as number) < 1 || (maxLength as number) > PATTERN_MAX_LENGTH
  ) {
    throw new Error(
      `Outcome ${label} schema pattern at ${path} requires maxLength between 1 and ${PATTERN_MAX_LENGTH}`,
    );
  }
}

// A bounded dynamic record declares supplier-defined keys whose values are
// bounded at runtime by the shared JSON budget, not by schema shape. The
// schema must therefore pin the key bounds, and a record may never form a
// whole request or response on its own.
function assertBoundedDynamicRecord(
  current: Record<string, unknown>,
  properties: unknown,
  label: string,
  path: string,
  depth: number,
): void {
  if (depth === 0) {
    throw new Error(`Outcome ${label} schema must not use a dynamic record at the root`);
  }
  const propertyNames = current.propertyNames as Record<string, unknown> | null | undefined;
  const maxProperties = current.maxProperties;
  const minProperties = current.minProperties;
  const valid =
    Object.keys(current).every((key) => RECORD_ALLOWED_KEYS.has(key)) &&
    RECORD_REQUIRED_KEYS.every((key) => key in current) &&
    properties !== null && typeof properties === "object" && !Array.isArray(properties) &&
    Object.keys(properties as Record<string, unknown>).length === 0 &&
    Number.isSafeInteger(maxProperties) &&
    (maxProperties as number) >= 1 && (maxProperties as number) <= 128 &&
    (minProperties === undefined ||
      (Number.isSafeInteger(minProperties) && (minProperties as number) >= 0 &&
        (minProperties as number) <= (maxProperties as number))) &&
    (current.description === undefined || typeof current.description === "string") &&
    propertyNames !== null && typeof propertyNames === "object" &&
    !Array.isArray(propertyNames) &&
    Object.keys(propertyNames as Record<string, unknown>).length === 1 &&
    Number.isSafeInteger((propertyNames as Record<string, unknown>).maxLength) &&
    ((propertyNames as Record<string, unknown>).maxLength as number) >= 1 &&
    ((propertyNames as Record<string, unknown>).maxLength as number) <= 128;
  if (!valid) {
    throw new Error(`Outcome ${label} schema has an invalid bounded dynamic record at ${path}`);
  }
}

function assertRecursivelyClosed(schema: Record<string, unknown>, label: string): void {
  const forbiddenKeywords = [
    "$ref", "$defs", "definitions", "patternProperties", "unevaluatedProperties",
    "dependentSchemas", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
    "contains", "prefixItems",
  ] as const;
  let nodes = 0;
  const visit = (node: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (depth > 32 || nodes > 10_000) throw new Error(`Outcome ${label} schema is too complex`);
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new Error(`Outcome ${label} schema must declare an explicit type at ${path}`);
    }
    const current = node as Record<string, unknown>;
    const unsupported = forbiddenKeywords.find((keyword) => keyword in current);
    if (unsupported) {
      throw new Error(`Outcome ${label} schema uses unsupported keyword ${unsupported} at ${path}`);
    }
    if ("propertyNames" in current && current.additionalProperties !== true) {
      throw new Error(`Outcome ${label} schema uses unsupported keyword propertyNames at ${path}`);
    }
    if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(
      current.type as string,
    )) throw new Error(`Outcome ${label} schema must declare an explicit type at ${path}`);
    if (current.type === "string") {
      assertBoundedPatternedString(current, label, path);
    } else if ("pattern" in current) {
      throw new Error(`Outcome ${label} schema uses pattern on a non-string at ${path}`);
    }
    if (current.type === "object") {
      const properties = current.properties;
      if (current.additionalProperties === true) {
        assertBoundedDynamicRecord(current, properties, label, path, depth);
        return;
      }
      if (
        current.additionalProperties !== false ||
        !properties || typeof properties !== "object" ||
        Array.isArray(properties)
      ) throw new Error(`Outcome ${label} schema must close object or use a bounded dynamic record at ${path}`);
      const propertyMap = properties as Record<string, unknown>;
      if (Object.keys(propertyMap).some((name) => UNSAFE_PROPERTY_NAMES.has(name))) {
        throw new Error(`Outcome ${label} schema contains an unsafe property name at ${path}`);
      }
      if (current.required !== undefined && (!Array.isArray(current.required) || current.required.some(
        (key) => typeof key !== "string" || !(key in propertyMap),
      ))) throw new Error(`Outcome ${label} schema has invalid required fields at ${path}`);
      for (const [name, child] of Object.entries(propertyMap)) {
        visit(child, `${path}.properties.${name}`, depth + 1);
      }
    }
    if (current.type === "array") {
      if (!current.items || typeof current.items !== "object" || Array.isArray(current.items)) {
        throw new Error(`Outcome ${label} array schema must declare typed items at ${path}`);
      }
      visit(current.items, `${path}.items`, depth + 1);
    }
  };
  visit(schema, "$", 0);
}

function compileClosedObjectSchema(
  schema: Record<string, unknown>,
  label: "request" | "response",
): ValidateFunction {
  assertRecursivelyClosed(schema, label);
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)
  ) throw new Error(`Outcome ${label} schema must be a closed JSON object schema`);
  return (schema.$schema === "https://json-schema.org/draft/2020-12/schema"
    ? ajv2020
    : ajv).compile(schema);
}

export function compileClosedRequestSchema(schema: Record<string, unknown>): ValidateFunction {
  return compileClosedObjectSchema(schema, "request");
}

export function compileClosedResponseSchema(schema: Record<string, unknown>): ValidateFunction {
  return compileClosedObjectSchema(schema, "response");
}

// The validator runs inside a vm context solely for its watchdog: V8 checks
// for termination while a regex backtracks, so a pattern that would otherwise
// pin the event loop is cut off at the budget. The function and the value
// stay main-realm objects; only the call originates from the context.
const budgetContext = vm.createContext(Object.create(null) as Record<string, unknown>);
const budgetScript = new vm.Script("validate(value)", { filename: "daski-schema-budget.vm" });

export function validateWithinBudget(
  validate: ValidateFunction,
  value: unknown,
  label: string,
  budgetMs: number = SCHEMA_VALIDATION_BUDGET_MS,
): boolean {
  const scope = budgetContext as Record<string, unknown>;
  scope.validate = validate;
  scope.value = value;
  try {
    return Boolean(budgetScript.runInContext(budgetContext, { timeout: budgetMs }));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new SchemaValidationBudgetError(label);
    }
    throw error;
  } finally {
    scope.validate = undefined;
    scope.value = undefined;
  }
}

// A client request that fails the closed outcome schema. Details are
// schema-derived only (paths, keywords, allowed enum values) — submitted
// values are never echoed back. The HTTP layer maps this to a 400; a
// Response-label failure stays a plain Error (that is our bug, not the
// client's) and keeps surfacing as a 500.
export class RequestSchemaError extends Error {
  readonly details: ReadonlyArray<{
    path: string;
    keyword: string;
    message: string;
    allowedValues?: readonly string[];
  }>;

  constructor(message: string, details: RequestSchemaError["details"]) {
    super(message);
    this.name = "RequestSchemaError";
    this.details = details;
  }
}

export function assertSchema(
  validate: ValidateFunction,
  value: unknown,
  label: "Request" | "Response" = "Request",
): asserts value is Record<string, unknown> {
  // One cumulative instance budget per value: dynamic-record contents are
  // invisible to the schema, so structural bounds must hold for the whole
  // document rather than per subtree.
  try {
    assertBoundedJsonValue(
      value,
      label === "Request" ? REQUEST_JSON_BUDGET : RESPONSE_JSON_BUDGET,
      label,
    );
  } catch (error) {
    if (label !== "Request") throw error;
    // Bounds messages are structural ("too deeply nested", "unsafe key") and
    // never echo submitted values — safe to hand back verbatim.
    const message = error instanceof Error
      ? error.message
      : "Request exceeds the accepted document bounds";
    throw new RequestSchemaError(message, []);
  }
  if (validateWithinBudget(validate, value, label)) return;
  if (label !== "Request") {
    throw new Error(`${label} does not match the closed outcome schema`);
  }
  const details = (validate.errors ?? []).slice(0, 8).map((schemaError) => {
    const allowedValues = (schemaError.params as { allowedValues?: unknown }).allowedValues;
    return {
      path: schemaError.instancePath || "$",
      keyword: schemaError.keyword,
      message: schemaError.message ?? "does not match the schema",
      ...(schemaError.keyword === "enum" &&
      Array.isArray(allowedValues) &&
      allowedValues.every((allowed) => typeof allowed === "string")
        ? { allowedValues: allowedValues as string[] }
        : {}),
    };
  });
  throw new RequestSchemaError("Request does not match the closed outcome schema", details);
}
