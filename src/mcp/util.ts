import type { Hex } from "../types.js";

// ── Default buyer agentURI (ERC-8004 §2.2 conformance) ─────────────────────
//
// ERC-8004 requires every Identity Registry tokenURI to resolve to an
// Agent Registration File. Empty URIs leave reputation queries and Bazaar /
// agentic.market indexers stranded. For fresh buyer wallets that have no
// off-chain hosting yet, we default to a `data:application/json;base64,...`
// URI containing a minimal stub. ~200-400 bytes of calldata; on Base
// Sepolia gas is negligible.
//
// `buildBuyerAgentURI` accepts an optional display name; callers that have
// no name fall back to the wallet-derived `buyer-<last6>` slug via
// `defaultBuyerAgentURI`. Names are NOT validated/sanitized here — pass
// pre-sanitized values from `sanitizeBuyerName`.
export function buildBuyerAgentURI(
  walletAddress: Hex,
  name?: string,
): string {
  const lower = walletAddress.toLowerCase();
  const resolvedName = name ?? `buyer-${lower.slice(-6)}`;
  const card = {
    name: resolvedName,
    type: "buyer",
    wallet: lower,
    endpoints: {},
  };
  const b64 = Buffer.from(JSON.stringify(card)).toString("base64");
  return `data:application/json;base64,${b64}`;
}

export function defaultBuyerAgentURI(walletAddress: Hex): string {
  return buildBuyerAgentURI(walletAddress);
}

// Wallet-derived default name. Callers that need to surface "the name we
// would have picked" without rebuilding the URI can use this directly.
export function defaultBuyerName(walletAddress: Hex): string {
  return `buyer-${walletAddress.toLowerCase().slice(-6)}`;
}

// ── Buyer display-name validation ──────────────────────────────────────────
//
// Free-form, NOT enforced unique. We trim whitespace, cap length at 64
// chars, and reject anything containing C0/C1 control chars. Unicode
// letters, digits, spaces, common punctuation are all fine. Rationale: see
// the buyer-naming spec — uniqueness is a stage-3 ENS concern, not ours.
const BUYER_NAME_MAX_LENGTH = 64;

export interface SanitizedBuyerName {
  ok: true;
  name: string;
}
export interface SanitizedBuyerNameError {
  ok: false;
  error: string;
}

export function sanitizeBuyerName(
  raw: unknown,
): SanitizedBuyerName | SanitizedBuyerNameError {
  if (typeof raw !== "string") {
    return { ok: false, error: "name must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "name must not be empty" };
  }
  if (trimmed.length > BUYER_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `name must be ${BUYER_NAME_MAX_LENGTH} characters or fewer`,
    };
  }
  // Reject C0 (\x00–\x1F) and C1/DEL (\x7F) control characters. These
  // disrupt downstream display in receipts and CLI output and have no
  // legitimate use in a display name.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return {
        ok: false,
        error: "name must not contain control characters",
      };
    }
  }
  return { ok: true, name: trimmed };
}

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
  details?: Record<string, unknown>;
  recoverable?: boolean;
  next_action?: string;
}

// Index signature mirrors the SDK's CallToolResult shape (which extends
// Result and therefore allows arbitrary string-keyed extensions); without
// it TypeScript rejects passing this value where the SDK expects its
// inferred return type.
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
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
  return {
    ok: false,
    error: mcpError({
      code: "missing_fields",
      message: `serviceArgs missing required field(s): ${missing.join(", ")}`,
      details: {
        missingFields: missing,
        requiredFields: [...requiredFields],
        acceptedShapes: [
          "flat: { firstName, lastName, ... }",
          "nested: { registrant: { firstName, lastName, ... } }",
        ],
      },
      recoverable: true,
      next_action:
        "Add the missing fields to serviceArgs (either flat or nested under `registrant`/`admin`/`tech`/`billing`) and retry.",
    }),
  };
}
