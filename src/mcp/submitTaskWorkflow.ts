import type { Fetcher } from "./a2a.js";
import { dispatchSubmitTask } from "./submitTaskDispatch.js";
import { prepareSubmitTaskEnvelope } from "./submitTaskEnvelope.js";
import { resolveSubmitTaskPayment } from "./submitTaskPayment.js";
import type { SubmitTaskArgs } from "./submitTaskTypes.js";
import type { McpDeps } from "./server.js";
import {
  findCatalogSkillAtA2AEndpoint,
} from "./providerCatalog.js";
import { requireFreshCatalogMatch } from "./freshProvider.js";
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
        "currently admitted provider. No outbound request was made.",
    });
  }

  const fresh = await requireFreshCatalogMatch(
    catalogEndpoint.provider.agentId,
    deps.providerAuthority,
    () =>
      findCatalogSkillAtA2AEndpoint(
        deps.cache,
        args.providerA2AUrl,
        args.skillId,
      ),
  );
  if (!fresh.ok) return fresh.result;
  const freshEndpoint = fresh.endpoint;
  if (
    args.taskId &&
    args.capability &&
    args.capability.authorization.providerAgentId !==
      freshEndpoint.provider.agentId.toString()
  ) {
    return mcpError({
      code: "CAPABILITY_PROVIDER_MISMATCH",
      message:
        "The task capability is not bound to the selected provider. No outbound request was made.",
    });
  }

  const paymentContext = await resolveSubmitTaskPayment(
    args,
    freshEndpoint.skillMeta,
    deps.queries,
  );
  if (!paymentContext.ok) return paymentContext.result;
  const normalizedArgs = paymentContext.args;

  const envelope = await prepareSubmitTaskEnvelope(
    normalizedArgs,
    paymentContext.requiresEnvelopeAuth,
    deps,
  );
  if (envelope) return envelope;

  return dispatchSubmitTask({
    args: {
      ...normalizedArgs,
      providerA2AUrl: freshEndpoint.url,
    },
    paidChallenge: paymentContext.paidChallenge,
    providerAgentId: freshEndpoint.provider.agentId,
    config: deps.config,
    transport,
    queries: deps.queries,
  });
}
