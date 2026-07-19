// A2A v1.0 inbound normalizers.
//
// Mirrors daski-provider/src/a2a/parts.ts. The provider now emits
// ProtoJSON enum strings (TASK_STATE_*, ROLE_USER/AGENT) per A2A
// v1.0 §5.5/§6. MCP responses use a compact lowercase representation,
// while inbound provider values must use the current ProtoJSON enums.

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
};

const ROLE_INBOUND: Record<string, "user" | "agent"> = {
  ROLE_USER: "user",
  ROLE_AGENT: "agent",
};

// Normalize an A2A v1.0 ProtoJSON task state for the MCP response.
export function normalizeState(state: unknown): string | undefined {
  if (typeof state !== "string") return undefined;
  return STATE_INBOUND[state];
}

// Normalize an A2A v1.0 ProtoJSON role for the MCP response.
export function normalizeRole(role: unknown): string | undefined {
  if (typeof role !== "string") return undefined;
  return ROLE_INBOUND[role];
}
