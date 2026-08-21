const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const CIRCULAR = "[CIRCULAR]";
const MAX_DEPTH = 5;
const MAX_KEYS = 50;
const MAX_ARRAY_ITEMS = 25;
const MAX_STRING_LENGTH = 2_048;
const MAX_STACK_FRAMES = 12;

const SENSITIVE_KEY =
  /(?:private[_-]?key|secret|password|credential|authorization|signature|(?:api|access|refresh|auth)[_-]?token|(?:serialized|prepared|signed|raw)[_-]?(?:transaction|tx)|rpc[_-]?(?:body|params)|^(?:body|params|headers)$)/i;
const LONG_HEX = /0x[0-9a-fA-F]{65,}/g;
const SECRET_SIZED_HEX = /0x[0-9a-fA-F]{64}\b/g;
const PUBLIC_HASH_KEY =
  /(?:transaction|tx|attestation|service|feedback)[_-]?(?:hash|ref|uid)?$/i;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const URL_TEXT = /https?:\/\/[^\s"'<>]+/gi;


export function sanitizeLogMessage(message: string): string {
  return sanitizeString(message).replace(SECRET_SIZED_HEX, REDACTED);
}

export function sanitizeLogDetails(value: unknown): unknown {
  try {
    return sanitizeValue(value, 0, new WeakSet<object>());
  } catch {
    return REDACTED;
  }
}


function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  key?: string,
): unknown {
  if (value === null) return null;
  if (value === undefined) return "[UNDEFINED]";
  if (key && /(?:^|[_-])error$/i.test(key) && !(value instanceof Error)) {
    return {
      name: "NonErrorThrown",
      type: Array.isArray(value) ? "array" : typeof value,
    };
  }
  if (typeof value === "string") {
    const sanitized = sanitizeString(value);
    return key && PUBLIC_HASH_KEY.test(key)
      ? sanitized
      : sanitized.replace(SECRET_SIZED_HEX, REDACTED);
  }
  if (typeof value === "bigint") return value.toString();
  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return `[${(typeof value).toUpperCase()}]`;
  }
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (value instanceof Error) return sanitizeError(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return safeUrl(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value.byteLength > 32
      ? REDACTED
      : `0x${Buffer.from(value).toString("hex")}`;
  }
  if (typeof value !== "object") return REDACTED;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, depth + 1, seen, key));
      if (value.length > MAX_ARRAY_ITEMS) output.push(TRUNCATED);
      return output;
    }
    const output: Record<string, unknown> = {};
    const descriptors = Object.entries(
      Object.getOwnPropertyDescriptors(value),
    ).slice(0, MAX_KEYS);
    for (const [key, descriptor] of descriptors) {
      const safeKey = sanitizeString(key).slice(0, 128);
      if (SENSITIVE_KEY.test(key)) {
        output[safeKey] = REDACTED;
      } else if ("value" in descriptor) {
        output[safeKey] = sanitizeValue(
          descriptor.value,
          depth + 1,
          seen,
          key,
        );
      } else {
        output[safeKey] = "[ACCESSOR]";
      }
    }
    if (Object.keys(value).length > MAX_KEYS) output[TRUNCATED] = true;
    return output;
  } finally {
    seen.delete(value);
  }
}

function sanitizeError(error: Error): Record<string, unknown> {
  const record = objectRecord(error);
  const output: Record<string, unknown> = {
    name: SAFE_TOKEN.test(error.name) ? error.name : "Error",
  };
  const code = record?.code;
  if (
    (typeof code === "number" && Number.isFinite(code)) ||
    (typeof code === "string" && SAFE_TOKEN.test(code))
  ) {
    output.code = code;
  }
  if (typeof record?.stage === "string" && SAFE_TOKEN.test(record.stage)) {
    output.stage = record.stage;
  }
  if (typeof record?.retryable === "boolean") {
    output.retryable = record.retryable;
  }
  const frames = error.stack
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(isStackFrame)
    .slice(0, MAX_STACK_FRAMES)
    .map(sanitizeString);
  if (frames && frames.length > 0) output.stackFrames = frames;
  return output;
}

function isStackFrame(line: string): boolean {
  return /^at (?:async )?(?:(?:new )?.+ \(.+\)|(?:file:\/\/\/|\/|[A-Za-z]:\\|node:)\S+:\d+:\d+)$/.test(
    line,
  );
}

function sanitizeString(value: string): string {
  const withoutControls = value.replace(/[\r\n\t]+/g, " ");
  const withoutLongHex = withoutControls.replace(LONG_HEX, REDACTED);
  const withoutUrlSecrets = withoutLongHex.replace(URL_TEXT, (candidate) => {
    try {
      return safeUrl(new URL(candidate));
    } catch {
      return REDACTED;
    }
  });
  return withoutUrlSecrets.length > MAX_STRING_LENGTH
    ? `${withoutUrlSecrets.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}`
    : withoutUrlSecrets;
}

function safeUrl(url: URL): string {
  const safe = new URL(url.toString());
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.toString();
}

function objectRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
