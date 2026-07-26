import type { ReplyPolicy } from "./replyPolicy.js";

// ── Principal update ─────────────────────────────────────────────────────
//
// A gateway-composed, ready-to-relay account of a task result: what
// happened, what happens next, and what is NOT happening (background
// monitoring). Composed ONLY from whitelisted structured facts — provider
// free text never occupies an instruction position (it stays in
// `messages`/`replyPolicy.text` under the relay binding).
//
// Why it exists (260725 review): agents kept authoring these claims
// themselves and getting them wrong in both directions — emailDelivery
// receipts omitted or overstated ("a copy was emailed" vs `attachment:
// false` + "Do not assert inbox arrival"), DNS propagation speculation
// appended to correct relays, and invented monitoring promises filling
// the close ("I'll keep an eye on it") because the platform handed the
// agent nothing true to say about the future. This block fills that
// vacuum with backed content.

export interface PrincipalUpdate {
  summary: string;
  evidence: {
    taskId: string | null;
    status: string;
    observedAt: string;
  };
  facts?: Record<string, unknown>;
  nextSteps: string[];
  monitoring: {
    active: false;
    note: string;
    suggestedRecheckAfter: null;
  };
}

const MONITORING_NOTE =
  "No background monitoring is active: nothing on the platform will " +
  "notify this session when the state changes. Tell your principal " +
  "plainly that you are not watching this in the background and that " +
  "they can ask you to re-check at any time.";

interface BuildInput {
  taskId: string | null | undefined;
  status: string;
  artifacts?: unknown;
  replyPolicy?: ReplyPolicy | null;
}

export function buildPrincipalUpdate(input: BuildInput): PrincipalUpdate {
  const facts = scanFacts(input.artifacts);
  const summaryParts: string[] = [statusSentence(input.status)];
  if (input.replyPolicy) {
    summaryParts.push(
      "The provider attached a fixed status notice — relay " +
        "replyPolicy.text to your principal VERBATIM and add nothing.",
    );
  }
  if (facts.emailDelivery) {
    summaryParts.push(emailDeliverySentence(facts.emailDelivery));
  }
  if (facts.publicResolutionVerified === false) {
    summaryParts.push(
      "Configuration is registrar-side only — public DNS propagation and " +
        "external resolution were NOT checked, so do not describe " +
        "anything as live or resolving.",
    );
  }
  return {
    summary: summaryParts.join(" "),
    evidence: {
      taskId: input.taskId ?? null,
      status: input.status,
      observedAt: new Date().toISOString(),
    },
    ...(Object.keys(facts).length > 0 ? { facts } : {}),
    nextSteps: nextSteps(input.status, facts),
    monitoring: {
      active: false,
      note: MONITORING_NOTE,
      suggestedRecheckAfter: null,
    },
  };
}

function statusSentence(status: string): string {
  switch (status) {
    case "completed":
      return "The provider reports this task as completed.";
    case "working":
      return (
        "The task is in progress on the provider side. No completion " +
        "estimate is available — do not invent one."
      );
    case "input-required":
      return (
        "The provider needs corrected input before this task can continue."
      );
    case "failed":
      return "The provider reports this task as failed.";
    case "submitted":
      return "The task was accepted by the provider and is queued.";
    default:
      return `Task state: ${status}.`;
  }
}

function nextSteps(
  status: string,
  facts: Record<string, unknown>,
): string[] {
  switch (status) {
    case "completed": {
      const steps: string[] = [];
      if (facts.hasFileArtifact === true) {
        steps.push(
          "Fetch the delivered document with daski_fetch_artifact and " +
            "hand the file itself to your principal.",
        );
      }
      steps.push(
        "Attest the outcome on-chain with daski_confirm_delivery once " +
          "the deliverable is verified in hand.",
      );
      return steps;
    }
    case "input-required":
      return [
        "Relay the provider's field-precise correction request to your " +
          "principal, then resubmit the corrected FULL payload with " +
          'daski_submit_task (taskId + action="input").',
      ];
    case "working":
    case "submitted":
      return [
        "Re-check on demand with daski_get_task_status — there is " +
          "nothing else to do right now.",
      ];
    case "failed":
      return [
        "Verify the final state and any refund with daski_get_task_status " +
          "before considering a retry; attest NotConfirmed with " +
          "daski_confirm_delivery if a settled payment was not delivered.",
      ];
    default:
      return ["Re-check with daski_get_task_status."];
  }
}

// ── Whitelisted fact scan ────────────────────────────────────────────────
//
// Walks the (already sanitized) artifacts structure for a small closed set
// of daski-extension fields. Bounded depth, first hit wins. Unknown
// provider fields never reach the composed sentences.

const MAX_SCAN_DEPTH = 6;

function scanFacts(artifacts: unknown): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  walk(artifacts, 0, facts);
  return facts;
}

function walk(
  node: unknown,
  depth: number,
  facts: Record<string, unknown>,
): void {
  if (depth > MAX_SCAN_DEPTH || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1, facts);
    return;
  }
  if (typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (
    facts.emailDelivery === undefined &&
    isRecord(record.emailDelivery) &&
    typeof record.emailDelivery.status === "string"
  ) {
    facts.emailDelivery = {
      status: record.emailDelivery.status,
      ...(typeof record.emailDelivery.to === "string"
        ? { to: record.emailDelivery.to.slice(0, 120) }
        : {}),
      ...(typeof record.emailDelivery.attachment === "boolean"
        ? { attachment: record.emailDelivery.attachment }
        : {}),
    };
  }
  if (
    facts.publicResolutionVerified === undefined &&
    typeof record.publicResolutionVerified === "boolean"
  ) {
    facts.publicResolutionVerified = record.publicResolutionVerified;
  }
  if (
    (record.type === "file" || record.kind === "file") &&
    (typeof record.url === "string" || typeof record.bytes === "string")
  ) {
    facts.hasFileArtifact = true;
  }
  for (const value of Object.values(record)) walk(value, depth + 1, facts);
}

function emailDeliverySentence(fact: unknown): string {
  const record = isRecord(fact) ? fact : {};
  if (record.status !== "sent") {
    return (
      "The provider reports the notification email was NOT sent " +
      `(status: ${String(record.status).slice(0, 40)}) — do not claim any ` +
      "email was dispatched."
    );
  }
  const to = typeof record.to === "string" ? ` to ${record.to}` : "";
  return (
    `The provider reports a summary email was dispatched${to}. Do NOT ` +
    "assert inbox arrival, and the document is linked from that email, " +
    "not attached."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
