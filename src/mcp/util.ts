import type { Hex } from "../types.js";

// ── Default buyer agentURI (ERC-8004 §2.2 conformance) ─────────────────────
//
// ERC-8004 requires every Identity Registry tokenURI to resolve to an
// Agent Registration File. Empty URIs leave reputation queries and Bazaar /
// agentic.market indexers stranded. For fresh buyer wallets that have no
// off-chain hosting yet, we default to a `data:application/json;base64,...`
// URI containing a minimal stub. ~200-400 bytes of calldata; on Base
// Sepolia gas is negligible.
export function defaultBuyerAgentURI(walletAddress: Hex): string {
  const lower = walletAddress.toLowerCase();
  const short = lower.slice(-6);
  const card = {
    name: `buyer-${short}`,
    type: "buyer",
    wallet: lower,
    endpoints: {},
  };
  const b64 = Buffer.from(JSON.stringify(card)).toString("base64");
  return `data:application/json;base64,${b64}`;
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
