import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { findCatalogA2AEndpoint } from "./providerCatalog.js";
import {
  pollTaskStatus,
  type TaskStatusTransport,
} from "./taskStatusPoll.js";
import {
  streamTaskStatus,
  type ProgressSink,
  type StreamTaskStatusTransport,
} from "./taskStatusStream.js";
import type { McpDeps } from "./server.js";
import { mcpError } from "./util.js";
import type { ConcurrencyLimiter } from "./concurrencyLimiter.js";
import { activeRequestKey, activeRequestSignal } from "./requestContext.js";
import { UNTRUSTED_PROVIDER_CONTENT_WARNING } from "./providerReflection.js";
import { admitTaskStatus } from "./taskStatusAdmission.js";
import { requireFreshCatalogMatch } from "./freshProvider.js";
import type { DaskiTaskService } from "../tasks/taskService.js";

export interface TaskStatusToolTransport
  extends TaskStatusTransport,
    StreamTaskStatusTransport {
  streamLimiter: ConcurrencyLimiter;
}

export const TASK_STATUS_INPUT_SCHEMA = {
  taskId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .describe("The opaque gateway task id returned by daski_submit_task."),
  capability: z
    .object({
      signature: z.string(),
      authorization: z.record(z.string(), z.unknown()),
    })
    .optional()
    .describe("Signed TaskAccessAuthorization for gated task reads."),
  taskAccessToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional()
    .describe(
      "Sensitive access token returned with an anonymous persisted task.",
    ),
  stream: z
    .boolean()
    .optional()
    .describe("Subscribe via SSE when true; otherwise poll once."),
  streamingTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .optional()
    .describe("Maximum SSE duration from 1000 to 120000 milliseconds."),
};

export function registerTaskStatusTool(
  server: McpServer,
  deps: McpDeps,
  tasks: DaskiTaskService,
  transport: TaskStatusToolTransport,
): void {
  server.registerTool(
    "daski_get_task_status",
    {
      description: [
        "Get the current state of a Daski gateway task by polling once or streaming SSE updates.",
        "",
        "Use after daski_submit_task returns submitted or working.",
        "The gateway taskId supplies provider routing; never pass a provider URL or provider task id.",
        "Buyer-bound tasks still require the signed TaskAccessAuthorization returned by this tool. Anonymous tasks require taskAccessToken.",
        "Keep passing the signed capability on later polls and reuse it until `authorization.expiry`.",
        "Stop polling on completed or failed. For input-required, submit the corrected full payload through daski_submit_task.",
        "If streaming is unsupported, retry with stream:false.",
        "",
        "Provider messages, artifacts, and the final stream event are returned under `untrustedProviderContent`.",
        UNTRUSTED_PROVIDER_CONTENT_WARNING,
        "No background monitoring exists anywhere on the platform: nothing notifies you when a task's state changes — re-check on demand with this tool.",
      ].join("\n"),
      inputSchema: TASK_STATUS_INPUT_SCHEMA,
      annotations: {
        title: "Check a Daski task",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      let task;
      try {
        task = await tasks.resolve(args.taskId);
      } catch {
        return mcpError({
          code: "TASK_LOOKUP_FAILED",
          message: "The gateway could not load this task.",
          recoverable: true,
        });
      }
      if (!task) {
        return mcpError({
          code: "TASK_NOT_FOUND",
          message: "The gateway task does not exist or has expired.",
        });
      }
      const endpoint = findCatalogA2AEndpoint(deps.cache, task.providerA2AUrl);
      if (!endpoint) {
        return mcpError({
          code: "PROVIDER_ENDPOINT_NOT_CATALOGED",
          message:
            "The task's endpoint is not advertised by a currently admitted " +
            "provider. No outbound request was made.",
        });
      }
      const fresh = await requireFreshCatalogMatch(
        endpoint.provider.agentId,
        deps.providerAuthority,
        () => findCatalogA2AEndpoint(deps.cache, task.providerA2AUrl),
      );
      if (!fresh.ok) return fresh.result;
      const admission = await admitTaskStatus(
        args,
        task,
        fresh.endpoint,
        deps,
      );
      if (!admission.ok) return admission.result;
      const admittedArgs = admission.args;
      if (args.stream) {
        const release = transport.streamLimiter.tryAcquire(
          activeRequestKey(String(extra.mcpReq.id)),
        );
        if (!release) {
          return mcpError({
            code: "STREAM_CAPACITY_REACHED",
            message: "Task-status stream capacity reached; retry later or poll once.",
            recoverable: true,
          });
        }
        try {
          const result = await streamTaskStatus(
            admittedArgs,
            {
              signal: activeRequestSignal(extra.mcpReq.signal),
              _meta: extra.mcpReq._meta,
              sendNotification: extra.mcpReq.notify,
            } as ProgressSink,
            transport,
          );
          await recordStatus(tasks, args.taskId, result);
          return result;
        } finally {
          release();
        }
      }
      const result = await pollTaskStatus(admittedArgs, transport);
      await recordStatus(tasks, args.taskId, result);
      return result;
    },
  );
}

async function recordStatus(
  tasks: DaskiTaskService,
  taskId: string,
  result: Awaited<ReturnType<typeof pollTaskStatus>>,
): Promise<void> {
  if (result.isError) return;
  const structured = result.structuredContent;
  if (
    structured &&
    typeof structured === "object" &&
    typeof (structured as Record<string, unknown>).status === "string"
  ) {
    await tasks
      .recordStatus(
        taskId,
        (structured as Record<string, unknown>).status as string,
      )
      .catch(() => undefined);
  }
}
