import type { Fetcher } from "./a2a.js";
import { dispatchSubmitTask } from "./submitTaskDispatch.js";
import {
  prepareSubmitTaskEnvelope,
  rejectUnsignedAuthenticatedPrompt,
  verifySubmitTaskEnvelope,
} from "./submitTaskEnvelope.js";
import { resolveSubmitTaskPayment } from "./submitTaskPayment.js";
import type { SubmitTaskArgs } from "./submitTaskTypes.js";
import type { RoutedSubmitTaskArgs } from "./submitTaskTypes.js";
import type { McpDeps } from "./server.js";
import type { DaskiTask, DaskiTaskService } from "../tasks/taskService.js";
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
  tasks: DaskiTaskService,
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

  const routed = await resolveTaskRouting(args, deps, tasks);
  if (!routed.ok) return routed.result;
  const routedArgs = routed.args;

  const catalogEndpoint = findCatalogSkillAtA2AEndpoint(
    deps.cache,
    routedArgs.providerA2AUrl,
    routedArgs.skillId,
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
        routedArgs.providerA2AUrl,
        routedArgs.skillId,
      ),
  );
  if (!fresh.ok) return fresh.result;
  const freshEndpoint = fresh.endpoint;
  const expectedBuyerTokenId = routed.task?.buyerTokenId;
  if (
    routed.task &&
    routedArgs.capability &&
    routedArgs.capability.authorization.providerAgentId !==
      freshEndpoint.provider.agentId.toString()
  ) {
    return mcpError({
      code: "CAPABILITY_PROVIDER_MISMATCH",
      message:
        "The task capability is not bound to the selected provider. No outbound request was made.",
    });
  }
  if (
    routed.task &&
    routedArgs.capability &&
    routedArgs.capability.authorization.buyerTokenId !==
      expectedBuyerTokenId?.toString()
  ) {
    return mcpError({
      code: "CAPABILITY_BUYER_MISMATCH",
      message:
        "The task capability is not bound to the task's buyer. No outbound request was made.",
    });
  }

  const paymentContext = await resolveSubmitTaskPayment(
    routedArgs,
    freshEndpoint.skillMeta,
    deps.queries,
  );
  if (!paymentContext.ok) return paymentContext.result;
  const normalizedArgs = paymentContext.args;

  const unsignedPrompt = rejectUnsignedAuthenticatedPrompt(
    normalizedArgs,
    paymentContext.requiresEnvelopeAuth,
  );
  if (unsignedPrompt) return unsignedPrompt;

  const envelope = await prepareSubmitTaskEnvelope(
    normalizedArgs,
    paymentContext.requiresEnvelopeAuth,
    { ...deps, providerAgentId: freshEndpoint.provider.agentId },
  );
  if (envelope) return envelope;
  const invalidEnvelope = await verifySubmitTaskEnvelope(
    normalizedArgs,
    paymentContext.paidChallenge,
    { ...deps, providerAgentId: freshEndpoint.provider.agentId },
  );
  if (invalidEnvelope) return invalidEnvelope;

  return dispatchSubmitTask({
    args: {
      ...normalizedArgs,
      providerA2AUrl: freshEndpoint.url,
    },
    gatewayTaskId: routed.gatewayTaskId,
    paidChallenge: paymentContext.paidChallenge,
    expectedBuyerTokenId,
    providerAgentId: freshEndpoint.provider.agentId,
    config: deps.config,
    transport,
    tasks,
  });
}

type RoutingResult =
  | {
      ok: true;
      args: RoutedSubmitTaskArgs;
      gatewayTaskId?: string;
      task?: DaskiTask;
    }
  | { ok: false; result: McpToolResult };

async function resolveTaskRouting(
  args: SubmitTaskArgs,
  deps: McpDeps,
  tasks: DaskiTaskService,
): Promise<RoutingResult> {
  if (!args.taskId) {
    const missing = [
      ["providerA2AUrl", args.providerA2AUrl],
      ["skillId", args.skillId],
      ["paymentId", args.paymentId],
      ["chainId", args.chainId],
    ].filter(([, value]) => value === undefined);
    if (missing.length > 0) {
      return {
        ok: false,
        result: mcpError({
          code: "BAD_INPUT",
          message:
            `New tasks require ${missing.map(([name]) => name).join(", ")}.`,
        }),
      };
    }
    return { ok: true, args: args as RoutedSubmitTaskArgs };
  }

  const conflicting = [
    "providerA2AUrl",
    "skillId",
    "paymentId",
    "chainId",
    "buyerTokenId",
    "walletAddress",
    "messageId",
    "contextId",
  ].filter((key) => args[key as keyof SubmitTaskArgs] !== undefined);
  if (conflicting.length > 0) {
    return {
      ok: false,
      result: mcpError({
        code: "BAD_INPUT",
        message:
          `Task input derives routing from taskId; omit ${conflicting.join(", ")}.`,
        recoverable: true,
        next_action:
          "Retry with taskId, the corrected serviceArgs, and capability when requested.",
      }),
    };
  }

  let task;
  try {
    task = await tasks.resolve(args.taskId);
  } catch {
    return {
      ok: false,
      result: mcpError({
        code: "TASK_LOOKUP_FAILED",
        message: "The gateway could not load this task.",
        recoverable: true,
      }),
    };
  }
  if (!task) {
    return {
      ok: false,
      result: mcpError({
        code: "TASK_NOT_FOUND",
        message: "The gateway task does not exist or has expired.",
      }),
    };
  }
  return {
    ok: true,
    gatewayTaskId: args.taskId,
    task,
    args: {
      ...args,
      providerA2AUrl: task.providerA2AUrl,
      skillId: task.skillId,
      paymentId: "0",
      chainId: deps.config.chainId,
      contextId: task.contextId,
      taskId: task.providerTaskId,
    },
  };
}
