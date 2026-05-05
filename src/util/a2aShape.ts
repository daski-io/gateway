// A2A v1.0 inbound normalizers.
//
// Mirrors daski-provider/src/a2a/parts.ts. The provider now emits
// ProtoJSON enum strings (TASK_STATE_*, ROLE_USER/AGENT) per A2A
// v1.0 §5.5/§6, but our MCP consumers and downstream tooling were
// written against the legacy lowercase / kebab forms. We normalize
// at the gateway boundary so neither side has to change at the
// same time, and so older providers (still on legacy strings) keep
// working.

const STATE_INBOUND: Record<string, string> = {
  TASK_STATE_SUBMITTED: "submitted",
  TASK_STATE_WORKING: "working",
  TASK_STATE_INPUT_REQUIRED: "input-required",
  TASK_STATE_COMPLETED: "completed",
  TASK_STATE_CANCELED: "canceled",
  TASK_STATE_FAILED: "failed",
  TASK_STATE_REJECTED: "rejected",
  TASK_STATE_AUTH_REQUIRED: "auth-required",
  TASK_STATE_UNKNOWN: "unknown",
  // Pass-through for legacy lowercase/kebab forms.
  submitted: "submitted",
  working: "working",
  "input-required": "input-required",
  completed: "completed",
  canceled: "canceled",
  failed: "failed",
  rejected: "rejected",
  "auth-required": "auth-required",
  unknown: "unknown",
};

const ROLE_INBOUND: Record<string, "user" | "agent"> = {
  ROLE_USER: "user",
  ROLE_AGENT: "agent",
  user: "user",
  agent: "agent",
};

// Normalize a task state from either A2A v1.0 ProtoJSON form
// (TASK_STATE_*) or legacy kebab to the legacy kebab form. Returns the
// raw input unchanged if it doesn't match either — preserves debugging
// info instead of silently coercing to "unknown".
export function normalizeState(state: unknown): string | undefined {
  if (typeof state !== "string") return undefined;
  return STATE_INBOUND[state] ?? state;
}

// Normalize a role from either ProtoJSON (ROLE_USER/AGENT) or legacy
// lowercase to legacy lowercase. Returns the raw input unchanged for
// unknown values.
export function normalizeRole(role: unknown): string | undefined {
  if (typeof role !== "string") return undefined;
  return ROLE_INBOUND[role] ?? role;
}
