export function isAlreadyKnownTransaction(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "object" && "message" in current
          ? String(current.message)
          : String(current);
    if (/\b(?:already known|known transaction)\b/i.test(message)) return true;
    current =
      typeof current === "object" && "cause" in current
        ? current.cause
        : undefined;
  }
  return false;
}
