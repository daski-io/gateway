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
  phase?: string;
  field?: string;
  requiresNewSignature?: boolean;
  paymentMayHaveSettled?: boolean;
  serverTime?: number;
  expected?: Record<string, unknown>;
  fieldErrors?: readonly { path: string; rule: string; message: string; allowedValues?: readonly string[] }[];
  docs?: string;
  correlationId?: string;
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
  fullText = false,
): McpToolResult {
  const result: McpToolResult = {
    content: [{
      type: "text" as const,
      text: fullText ? JSON.stringify(obj) : "Daski tool call succeeded.",
    }],
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
