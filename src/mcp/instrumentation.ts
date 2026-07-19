import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../util/logger.js";

/** Add one structured completion log to every registered MCP tool. */
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
        return result;
      } catch (error) {
        logger.error("mcp.tool_call", {
          toolName,
          ok: false,
          durationMs: Date.now() - startedAt,
          correlationId,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        throw error;
      }
    };
    return original(...registrationArgs);
  };
}
