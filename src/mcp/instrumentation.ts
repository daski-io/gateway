import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../util/logger.js";
import { sessionMetrics } from "./sessionMetrics.js";

/** First text block of an MCP tool result, for metrics parsing only. */
function resultText(result: unknown): string | null {
  const content = (result as { content?: unknown[] } | null)?.content;
  const first = Array.isArray(content) ? content[0] : null;
  return first &&
    typeof first === "object" &&
    (first as { type?: unknown }).type === "text" &&
    typeof (first as { text?: unknown }).text === "string"
    ? ((first as { text: string }).text)
    : null;
}

/**
 * Add one structured completion log to every registered MCP tool, and feed
 * the per-session telemetry rollup (sessionMetrics.ts).
 */
export function instrumentToolCalls(server: McpServer): void {
  const original = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown })
    .registerTool = (...registrationArgs: unknown[]) => {
    const callbackIndex = registrationArgs.length - 1;
    const callback = registrationArgs[callbackIndex];
    const toolName = String(registrationArgs[0]);
    if (typeof callback !== "function") {
      return original(...registrationArgs);
    }
    registrationArgs[callbackIndex] = async (...callbackArgs: unknown[]) => {
      const startedAt = Date.now();
      const correlationId = randomUUID();
      // The SDK passes the request context as the final callback argument;
      // its sessionId keys the per-session rollup.
      const extra = callbackArgs[callbackArgs.length - 1] as
        | { sessionId?: string }
        | undefined;
      try {
        const result = await callback(...callbackArgs);
        const isError =
          typeof result === "object" &&
          result !== null &&
          (result as { isError?: unknown }).isError === true;
        logger.info("mcp.tool_call", {
          toolName,
          ok: !isError,
          durationMs: Date.now() - startedAt,
          correlationId,
        });
        sessionMetrics.record(
          extra?.sessionId,
          toolName,
          isError,
          resultText(result),
        );
        return result;
      } catch (error) {
        logger.error("mcp.tool_call", {
          toolName,
          ok: false,
          durationMs: Date.now() - startedAt,
          correlationId,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        sessionMetrics.record(extra?.sessionId, toolName, true, null);
        throw error;
      }
    };
    return original(...registrationArgs);
  };
}
