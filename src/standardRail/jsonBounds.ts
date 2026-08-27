/**
 * Cumulative structural budget for one untrusted JSON value. Schema
 * validation bounds shape; this bounds the instance itself. A single budget
 * covers the whole value, so bounded-record subtrees share one allowance
 * instead of multiplying it.
 */
export interface JsonBudget {
  maxDepth: number;
  maxNodes: number;
  maxKeyLength: number;
  maxStringLength: number;
}

export const REQUEST_JSON_BUDGET: JsonBudget = {
  maxDepth: 24,
  maxNodes: 32_768,
  maxKeyLength: 128,
  maxStringLength: 32_768,
};

// Provider responses may legitimately embed large document payloads, so the
// string bound stays near the transport byte limit while depth stays strict.
export const RESPONSE_JSON_BUDGET: JsonBudget = {
  maxDepth: 24,
  maxNodes: 65_536,
  maxKeyLength: 128,
  maxStringLength: 262_144,
};

export const UNSAFE_JSON_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function assertBoundedJsonValue(
  value: unknown,
  budget: JsonBudget,
  label: string,
): void {
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    nodes += 1;
    if (depth > budget.maxDepth) throw new Error(`${label} JSON is invalid: too deeply nested`);
    if (nodes > budget.maxNodes) throw new Error(`${label} JSON is invalid: too many values`);
    if (node === null || typeof node === "boolean") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new Error(`${label} JSON is invalid: non-finite number`);
      return;
    }
    if (typeof node === "string") {
      if (node.length > budget.maxStringLength) {
        throw new Error(`${label} JSON is invalid: string too long`);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") throw new Error(`${label} JSON is invalid: unsupported value`);
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key.length > budget.maxKeyLength) throw new Error(`${label} JSON is invalid: key too long`);
      if (UNSAFE_JSON_KEYS.has(key)) throw new Error(`${label} JSON is invalid: unsafe key`);
      if (child === undefined) continue;
      visit(child, depth + 1);
    }
  };
  visit(value, 1);
}
