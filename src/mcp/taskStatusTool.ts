import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export interface TaskStatusToolTransport
  extends TaskStatusTransport,
    StreamTaskStatusTransport {
  streamLimiter: ConcurrencyLimiter;
}

export const TASK_STATUS_INPUT_SCHEMA = {
  providerA2AUrl: z.string(),
  taskId: z.string().min(1).max(256).describe("The provider task id."),
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
  transport: TaskStatusToolTransport,
): void {
  server.registerTool(
    "daski_get_task_status",
    {
      description: [
        "Get the current state of a Daski provider task by polling once or streaming SSE updates.",
        "",
        "Use after daski_submit_task returns submitted or working.",
        "Buyer-bound tasks always require a signed TaskAccessAuthorization. Anonymous tasks require taskAccessToken.",
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
      const endpoint = findCatalogA2AEndpoint(
        deps.cache,
        args.providerA2AUrl,
      );
      if (!endpoint) {
        return mcpError({
          code: "PROVIDER_ENDPOINT_NOT_CATALOGED",
          message:
            "providerA2AUrl is not advertised by a currently admitted " +
            "provider. No outbound request was made.",
        });
      }
      const admission = await admitTaskStatus(args, endpoint, deps);
      if (!admission.ok) return admission.result;
      const admittedArgs = admission.args;
      if (args.stream) {
        const release = transport.streamLimiter.tryAcquire(
          activeRequestKey(extra.sessionId ?? "sessionless"),
        );
        if (!release) {
          return mcpError({
            code: "STREAM_CAPACITY_REACHED",
            message: "Task-status stream capacity reached; retry later or poll once.",
            recoverable: true,
          });
        }
        try {
          return await streamTaskStatus(
            admittedArgs,
            {
              signal: activeRequestSignal(extra.signal),
              _meta: extra._meta,
              sendNotification: extra.sendNotification,
            } as ProgressSink,
            transport,
          );
        } finally {
          release();
        }
      }
      return pollTaskStatus(admittedArgs, transport);
    },
  );
}
