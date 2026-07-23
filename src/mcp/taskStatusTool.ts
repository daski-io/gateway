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

export interface TaskStatusToolTransport
  extends TaskStatusTransport,
    StreamTaskStatusTransport {
  streamLimiter: ConcurrencyLimiter;
}

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
        "Pass a signed TaskAccessAuthorization capability when the provider requires it.",
        "Keep passing the signed capability on later polls and reuse it until `authorization.expiry`.",
        "Stop polling on completed or failed. For input-required, submit the corrected full payload through daski_submit_task.",
        "If streaming is unsupported, retry with stream:false.",
      ].join("\n"),
      inputSchema: {
        providerA2AUrl: z.string(),
        taskId: z.string(),
        capability: z
          .object({
            signature: z.string(),
            authorization: z.record(z.string(), z.unknown()),
          })
          .optional()
          .describe("Signed TaskAccessAuthorization for gated task reads."),
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
      },
      annotations: {
        title: "Check a Daski task",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      if (!findCatalogA2AEndpoint(deps.cache, args.providerA2AUrl)) {
        return mcpError({
          code: "PROVIDER_ENDPOINT_NOT_CATALOGED",
          message:
            "providerA2AUrl is not advertised by a currently admitted " +
            "provider. No outbound request was made.",
        });
      }
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
            args,
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
      return pollTaskStatus(args, transport);
    },
  );
}
