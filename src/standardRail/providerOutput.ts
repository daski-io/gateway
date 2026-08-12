const ACTIVE_CONTENT = /(?:javascript|vbscript)\s*:|data\s*:\s*text\/html|<\s*\/?\s*(?:script|iframe|object|embed|form|meta|link|style)\b|\bon[a-z]+\s*=/iu;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function assertPassiveProviderOutput(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (depth > 32 || nodes > 100_000) throw new Error("PROVIDER_OUTPUT_COMPLEXITY_INVALID");
    if (typeof current === "string") {
      if (ACTIVE_CONTENT.test(current) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(current)) {
        throw new Error("PROVIDER_OUTPUT_ACTIVE_CONTENT_REJECTED");
      }
      return;
    }
    if (current === null || typeof current === "boolean" || typeof current === "number") return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (typeof current !== "object") throw new Error("PROVIDER_OUTPUT_VALUE_INVALID");
    for (const [key, item] of Object.entries(current)) {
      if (UNSAFE_KEYS.has(key)) throw new Error("PROVIDER_OUTPUT_KEY_INVALID");
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}
