import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const ajv2020 = new Ajv2020({ allErrors: true, strict: true });
const UNSAFE_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function assertRecursivelyClosed(schema: Record<string, unknown>, label: string): void {
  const forbiddenKeywords = [
    "$ref", "$defs", "definitions", "patternProperties", "unevaluatedProperties",
    "dependentSchemas", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
    "contains", "prefixItems", "propertyNames",
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
    if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(
      current.type as string,
    )) throw new Error(`Outcome ${label} schema must declare an explicit type at ${path}`);
    if (current.type === "object") {
      if (
        current.additionalProperties !== false ||
        !current.properties || typeof current.properties !== "object" ||
        Array.isArray(current.properties)
      ) throw new Error(`Outcome ${label} schema must close object at ${path}`);
      const properties = current.properties as Record<string, unknown>;
      if (Object.keys(properties).some((name) => UNSAFE_PROPERTY_NAMES.has(name))) {
        throw new Error(`Outcome ${label} schema contains an unsafe property name at ${path}`);
      }
      if (current.required !== undefined && (!Array.isArray(current.required) || current.required.some(
        (key) => typeof key !== "string" || !(key in properties),
      ))) throw new Error(`Outcome ${label} schema has invalid required fields at ${path}`);
      for (const [name, child] of Object.entries(properties)) {
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
  if (!validate(value)) throw new Error(`${label} does not match the closed outcome schema`);
}
