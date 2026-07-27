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
  // MCP structured tool output (spec 2025-06-18): typed clients read
  // structuredContent; the text block stays the compatibility fallback.
  if (isPlainRecord(obj)) {
    result.structuredContent = obj as Record<string, unknown>;
  }
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
    structuredContent: payload as unknown as Record<string, unknown>,
  };
  if (meta) result._meta = meta;
  return result;
}

/**
 * An EXPECTED workflow transition: the operation is paused on a required
 * follow-up (a signature, an acknowledgement, a corrected input), not
 * failed. Returned as a SUCCESS result with a typed top-level
 * `status`/`action` discriminator — `isError` is reserved for genuine
 * failures (unreachable provider, invalid signature, malformed input).
 * Clients and agents retry, alert, or abandon on errors; an expected
 * transition must not read as one (260725 review, decision log #1).
 */
export function mcpActionRequired(
  action: string,
  payload: Record<string, unknown>,
  meta?: Record<string, unknown>,
): McpToolResult {
  return mcpJson(
    { status: "action-required", action, ...payload },
    meta,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

// ── Informational warnings (de-scar 260726) ───────────────────────────────
//
// The acknowledgement gates that lived here (PHONE_ACKNOWLEDGEMENT_REQUIRED
// token roundtrip, then a self-certifiable phoneAcknowledgement object, and
// BUYER_NAME_ACKNOWLEDGEMENT_REQUIRED) are gone: a model-provided boolean
// proves nothing, and the platform does not police how an agent talks to
// its principal. What remains is accurate information at the decision
// point — the quote result WARNS about consequential values so any caller
// can correct them before signing. Format validation (E.164 above) stays.

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

/** WHOIS-consequence note for phone values on a quote — informational. */
export function phoneWhoisWarnings(args: Record<string, unknown>): string[] {
  const phones = presentPhoneFields(args);
  if (phones.length === 0) return [];
  return [
    `Phone value(s) ${phones
      .map(({ field, value }) => `${field}='${value}'`)
      .join(", ")} will appear on public WHOIS exactly as sent — nothing ` +
      "further is required, but correct them before signing if wrong.",
  ];
}

/**
 * Buyer-name divergence note for an atomic first purchase: the identity
 * minted alongside this quote is permanent, so a resolved name that
 * diverges from the request's own stated organization — `companyName`
 * (entity formation) or `registrantOrganization` (domain registration,
 * the shape of the original buyer-0b83e2 incident) — is worth one warning
 * before anything is signed. A deliberate mismatch (a parent company
 * buying for a subsidiary) is legitimate — this never blocks.
 */
export function buyerNameMismatchWarning(
  resolvedName: string | null,
  serviceArgs: Record<string, unknown>,
): string | null {
  const stated = [serviceArgs.companyName, serviceArgs.registrantOrganization].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  if (!resolvedName || !stated) return null;
  const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = canon(resolvedName);
  const b = canon(stated);
  // Empty canonical forms (fully non-alphanumeric names) make the
  // containment test vacuously true — treat as incomparable, warn.
  if (a !== "" && b !== "" && (a.includes(b) || b.includes(a))) return null;
  return (
    `This purchase permanently registers the buyer as '${resolvedName}' ` +
    `while the request names the organization '${stated}'. If that is ` +
    "unintended, re-send with the corrected `name` BEFORE signing the " +
    "registration typed-data — the registered name cannot be changed later."
  );
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
