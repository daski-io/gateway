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

export function assertSchema(
  validate: ValidateFunction,
  value: unknown,
  label: "Request" | "Response" = "Request",
): asserts value is Record<string, unknown> {
  // One cumulative instance budget per value: dynamic-record contents are
  // invisible to the schema, so structural bounds must hold for the whole
  // document rather than per subtree.
  assertBoundedJsonValue(
    value,
    label === "Request" ? REQUEST_JSON_BUDGET : RESPONSE_JSON_BUDGET,
    label,
  );
  if (!validate(value)) throw new Error(`${label} does not match the closed outcome schema`);
}
