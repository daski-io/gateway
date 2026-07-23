import { createHmac, randomBytes } from "node:crypto";

// ── serviceArgs normalization (§3.2 — flat + nested registrant) ────────────
//
// Real registrar APIs split between flat (Namecheap: `RegistrantFirstName`)
// and nested (OpenSRS / Name.com: `contact_set.registrant.firstName`)
// shapes. Daski accepts either; before validating against the provider's
// requiredFields we hoist common contact subobjects to the top level so
// flat field names match against nested input.

const CONTACT_ROLES = ["registrant", "admin", "tech", "billing"] as const;

export function normalizeContactFields(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const role of CONTACT_ROLES) {
    const obj = args[role];
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (out[k] === undefined) out[k] = v;
      }
    }
  }
  return out;
}

// Dot-path lookup so requiredFields like "registrant.firstName" resolve
// against an args object that kept the nested shape (i.e. the provider
// uses dotted required names but the buyer supplied a nested object).
export function getField(
  args: Record<string, unknown>,
  field: string,
): unknown {
  if (!field.includes(".")) return args[field];
  const parts = field.split(".");
  let cur: unknown = args;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function isFieldPresent(
  args: Record<string, unknown>,
  field: string,
): boolean {
  const v = getField(args, field);
  return v !== undefined && v !== null && v !== "";
}

// ── Standardized MCP error shape (§3.8) ─────────────────────────────────────
//
// Every tool returns `{ isError: true, content: [{ type:"text", text: <JSON> }] }`
// where the JSON conforms to this schema. Stable `code` enum lets agents
// branch on failure type; `recoverable` + `next_action` tell the model
// whether to retry and how.
export interface McpErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  recoverable?: boolean;
  next_action?: string;
}

// Index signature mirrors the SDK's CallToolResult shape (which extends
// Result and therefore allows arbitrary string-keyed extensions); without
// it TypeScript rejects passing this value where the SDK expects its
// inferred return type. Content is text-first; tools that hand real files
// to the caller (artifact fetch) append an MCP embedded-resource block so
// clients can render/save the document instead of re-parsing JSON base64.
export interface McpToolResult {
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "resource";
        // Mirrors the SDK's EmbeddedResource union exactly: text XOR blob,
        // each required in its branch.
        resource:
          | { uri: string; text: string; mimeType?: string }
          | { uri: string; blob: string; mimeType?: string };
      }
  >;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export function mcpJson(
  obj: unknown,
  meta?: Record<string, unknown>,
): McpToolResult {
  const result: McpToolResult = {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
  };
  if (meta) result._meta = meta;
  return result;
}

export function mcpError(
  payload: McpErrorPayload,
  meta?: Record<string, unknown>,
): McpToolResult {
  const result: McpToolResult = {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
  if (meta) result._meta = meta;
  return result;
}

// ── Tagged-union helpers ───────────────────────────────────────────────────
//
// Both return either the parsed value or a fully-formed MCP error envelope
// the caller can `return` directly. The discriminator lives in `ok` so call
// sites stay readable:
//
//   const r = parseBigIntArg(args.id, "providerTokenId");
//   if (!r.ok) return r.error;
//   const id = r.value;

export type ParseBigIntResult =
  | { ok: true; value: bigint }
  | { ok: false; error: McpToolResult };

/** Parses a decimal numeric string into a bigint. The caller has already
 *  validated presence (zod gates this in the tool schema); this only maps
 *  the parse-error branch to a standardized MCP envelope. */
export function parseBigIntArg(
  raw: string,
  fieldName: string,
): ParseBigIntResult {
  try {
    return { ok: true, value: BigInt(raw) };
  } catch {
    return {
      ok: false,
      error: mcpError({
        code: "BAD_INPUT",
        message: `${fieldName} must be numeric`,
      }),
    };
  }
}

// Strict E.164. Leading `+`, country code 1-9, then 1-14 more digits, no
// separators. Mirrors the provider's `E164_STRICT` so the gateway catches
// the common "+1.555.555.0100" / "(555) 555-0100" mistakes one round-trip
// earlier than the provider would.
const E164_STRICT = /^\+[1-9]\d{1,14}$/;

// Known phone-shaped fields. Kept short and ICANN-WHOIS-flavoured because
// that's where E.164 enforcement bites buyers today. Adding new field
// names here is cheap (any future skill with a different naming
// convention extends cleanly).
const PHONE_FIELDS = [
  "registrantPhone",
  "adminPhone",
  "techPhone",
  "billingPhone",
  "phone",
] as const;

/** Returns the first phone-shaped field whose value is not strict E.164,
 *  or `null` when everything's fine (including when no phone field is
 *  present at all). Strings only — non-string values are treated as the
 *  caller's problem (a separate type error somewhere upstream). */
export function findInvalidPhoneField(
  args: Record<string, unknown>,
): { field: string; value: string } | null {
  for (const f of PHONE_FIELDS) {
    const v = args[f];
    if (typeof v !== "string") continue;
    if (!E164_STRICT.test(v)) {
      return { field: f, value: v };
    }
  }
  return null;
}

/** Build the standardized BAD_INPUT envelope for an E.164 phone failure.
 *  Pre-screen at the gateway saves a network hop to the provider. */
export function phoneFormatError(
  invalid: { field: string; value: string },
): McpToolResult {
  return mcpError({
    code: "BAD_INPUT",
    message:
      `Field '${invalid.field}' must be E.164 with no separators (pattern \`^\\+[1-9]\\d{1,14}\\$\`). ` +
      `Received '${invalid.value}'; expected something like '+15555550100'.`,
    details: {
      field: invalid.field,
      received: invalid.value,
      pattern: "^\\+[1-9]\\d{1,14}$",
      example: "+15555550100",
    },
    recoverable: true,
    next_action:
      "Strip dots, spaces, dashes, and parentheses from the phone number and retry.",
  });
}

/** Tool-side convenience: check every known phone field on a normalized
 *  serviceArgs map and surface the first violation as an MCP error. */
export function checkPhoneFields(
  args: Record<string, unknown>,
): McpToolResult | null {
  const bad = findInvalidPhoneField(args);
  return bad ? phoneFormatError(bad) : null;
}

// ── Phone acknowledgement gate ─────────────────────────────────────────────
//
// The E.164 check above catches FORMAT; it cannot catch a wrong-but-valid
// number. Live runs showed agents silently normalizing a principal's
// dotted phone and paying without ever echoing the result — numbers that
// land verbatim on public WHOIS. This gate makes the first plan-building
// call that carries phone fields fail with PHONE_ACKNOWLEDGEMENT_REQUIRED
// and a token HMAC-bound to the exact values; the caller is instructed to
// echo the numbers to the principal and retry with the token. No stateless
// scheme can prove the principal answered — the token only records that
// the caller acknowledged the exact public value, and invalidates that
// acknowledgement whenever a value changes. The secret is
// per-process: after a restart (or on a sibling instance) the token
// simply re-issues, costing one extra roundtrip, never blocking.
const PHONE_ACKNOWLEDGEMENT_SECRET = randomBytes(32);

export function presentPhoneFields(
  args: Record<string, unknown>,
): Array<{ field: string; value: string }> {
  const out: Array<{ field: string; value: string }> = [];
  for (const f of PHONE_FIELDS) {
    const v = args[f];
    if (typeof v === "string" && v !== "") out.push({ field: f, value: v });
  }
  return out;
}

export function expectedPhoneAcknowledgementToken(
  phones: Array<{ field: string; value: string }>,
): string {
  const canonical = phones
    .map(({ field, value }) => `${field}=${value}`)
    .sort()
    .join("&");
  return createHmac("sha256", PHONE_ACKNOWLEDGEMENT_SECRET)
    .update(canonical)
    .digest("hex")
    .slice(0, 32);
}

export function checkPhoneAcknowledgement(
  args: Record<string, unknown>,
  acknowledgementToken: string | undefined,
): McpToolResult | null {
  const phones = presentPhoneFields(args);
  if (phones.length === 0) return null;
  const expected = expectedPhoneAcknowledgementToken(phones);
  if (acknowledgementToken === expected) return null;
  return mcpError({
    code: "PHONE_ACKNOWLEDGEMENT_REQUIRED",
    message:
      "Phone number(s) in serviceArgs need your principal's explicit " +
      "acknowledgement before a payment plan is prepared: " +
      phones.map(({ field, value }) => `${field}='${value}'`).join(", ") +
      ". They will appear on public WHOIS exactly as sent. Echo the EXACT " +
      "value(s) back to your principal — if you normalized the number " +
      "(stripped dots/spaces/dashes), show the normalized form and say you " +
      "did (e.g. \"I'll register with phone +48221234567, normalized from " +
      "+48.221234567 — confirm or correct\"). Only after an explicit yes, " +
      "retry this same call with `phoneAcknowledgementToken` added. This " +
      "token records an acknowledgement, not proof of principal consent. " +
      "To avoid this roundtrip next time: pre-normalize the phone and have " +
      "your principal confirm the E.164 form in the SAME message where you " +
      "collect the contact data, BEFORE the first buy call.",
    details: {
      phones: Object.fromEntries(phones.map(({ field, value }) => [field, value])),
      phoneAcknowledgementToken: expected,
      tokenBinding:
        "bound to these exact field=value pairs — changing any phone value " +
        "requires a new acknowledgement",
    },
    recoverable: true,
    next_action:
      "Echo the exact phone value(s) to the principal, get an explicit " +
      "acknowledgement, then retry with phoneAcknowledgementToken.",
  });
}

/**
 * Keys in the buyer's raw serviceArgs that no advertised field consumes —
 * the skill will silently ignore them (observed: an agent passed
 * `displayName` to create-mailbox and only discovered at delivery that
 * mailboxes have no display name). Conservative by design: dotted field
 * names whitelist their container, contact-role containers are always
 * allowed, and the result feeds a WARNING, never a rejection.
 */
export function findUnknownServiceArgKeys(
  rawArgs: Record<string, unknown> | undefined,
  requiredFields: readonly string[],
  optionalFields: readonly string[],
): string[] {
  if (!rawArgs) return [];
  const allowed = new Set<string>(CONTACT_ROLES);
  for (const f of [...requiredFields, ...optionalFields]) {
    allowed.add(f);
    const dot = f.indexOf(".");
    if (dot > 0) allowed.add(f.slice(0, dot));
  }
  return Object.keys(rawArgs).filter((k) => !allowed.has(k));
}

export type ValidateServiceArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: McpToolResult };

/** Normalizes the caller's serviceArgs (hoists nested registrant/admin/
 *  tech/billing subobjects to the top level) and checks that every entry
 *  in `requiredFields` is present. Returns the standardized
 *  `missing_fields` envelope on failure — including a hint about the two
 *  accepted shapes — so call sites stop hand-rolling the same error
 *  payload. */
export function validateAndNormalizeServiceArgs(
  rawArgs: Record<string, unknown> | undefined,
  requiredFields: readonly string[],
): ValidateServiceArgsResult {
  const args = normalizeContactFields(rawArgs ?? {});
  const missing = requiredFields.filter((f) => !isFieldPresent(args, f));
  if (missing.length === 0) {
    return { ok: true, args };
  }
  // "Sent but blank" and "not sent" call for different recoveries: a blank
  // usually means the principal said "not applicable" and the agent's next
  // move should be a documented convention, not a fabricated value
  // (observed: empty registrantState → agent invented a province).
  const empty = missing.filter((f) => {
    const v = getField(args, f);
    return v !== undefined && v !== null;
  });
  const subdivisionAffected = missing.some((f) => /state/i.test(f));
  return {
    ok: false,
    error: mcpError({
      code: "missing_fields",
      message:
        `serviceArgs missing required field(s): ${missing.join(", ")}` +
        (empty.length > 0 ? ` (sent as empty string: ${empty.join(", ")})` : ""),
      details: {
        missingFields: missing,
        emptyFields: empty,
        requiredFields: [...requiredFields],
        acceptedShapes: [
          "flat: { firstName, lastName, ... }",
          "nested: { registrant: { firstName, lastName, ... } }",
        ],
        ...(subdivisionAffected
          ? {
              hint:
                "registrantState is required by the registry. If the registrant's " +
                "country has no ISO-3166-2 subdivision, re-use the city name rather " +
                "than leaving it blank. Never invent a province the principal did " +
                "not provide — ask them.",
            }
          : {}),
      },
      recoverable: true,
      next_action: subdivisionAffected
        ? "Ask your principal for the missing value(s). For a state/province in a " +
          "country without subdivisions, re-use the city name — do not send an " +
          "empty string and do not fabricate a region."
        : "Add the missing fields to serviceArgs (either flat or nested under `registrant`/`admin`/`tech`/`billing`) and retry.",
    }),
  };
}
