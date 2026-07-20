import type { Fetcher } from "./a2a.js";
import { dispatchSubmitTask } from "./submitTaskDispatch.js";
import { prepareSubmitTaskEnvelope } from "./submitTaskEnvelope.js";
import { resolveSubmitTaskPayment } from "./submitTaskPayment.js";
import type { SubmitTaskArgs } from "./submitTaskTypes.js";
import type { McpDeps } from "./server.js";
import {
  findCatalogSkillAtA2AEndpoint,
} from "./providerCatalog.js";
import { mcpError, type McpToolResult } from "./util.js";

interface SubmitTaskTransport {
  fetch: Fetcher;
  timeoutMs: number;
  maxResponseBytes: number;
}

export async function runSubmitTask(
  args: SubmitTaskArgs,
  deps: McpDeps,
  transport: SubmitTaskTransport,
): Promise<McpToolResult> {
  if (
    args.taskId &&
    (args.serviceRef || args.transactionHash || args.envelopeAuth)
  ) {
    const inCapabilityFlow = Boolean(args.envelopeAuth);
    return mcpError({
      code: "BAD_INPUT",
      message: inCapabilityFlow
        ? "A capability-gated write resubmit uses contextId, not taskId. " +
          "Remove taskId and keep the fresh envelope, capability, and serviceArgs."
        : "Task input must not include serviceRef, transactionHash, or envelopeAuth.",
      recoverable: true,
      next_action: inCapabilityFlow
        ? "Drop taskId and retry with contextId."
        : "Retry with taskId, serviceArgs, and capability when requested.",
    });
  }

  const catalogEndpoint = findCatalogSkillAtA2AEndpoint(
    deps.cache,
    args.providerA2AUrl,
    args.skillId,
  );
  if (!catalogEndpoint) {
    return mcpError({
      code: "SKILL_ENDPOINT_NOT_CATALOGED",
      message:
        "The providerA2AUrl and skillId pair is not advertised by a " +
        "currently whitelisted provider. No outbound request was made.",
    });
  }

  const paymentContext = await resolveSubmitTaskPayment(
    args,
    catalogEndpoint.skillMeta,
    deps.queries,
  );
  if (!paymentContext.ok) return paymentContext.result;

  const envelope = await prepareSubmitTaskEnvelope(
    args,
    paymentContext.requiresEnvelopeAuth,
    deps,
  );
  if (envelope) return envelope;

  return dispatchSubmitTask({
    args,
    paidChallenge: paymentContext.paidChallenge,
    config: deps.config,
    transport,
  });
}
