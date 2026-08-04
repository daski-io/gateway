import { createHash, randomUUID } from "node:crypto";
import {
  TRACEPARENT_META_KEY,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { logger } from "../util/logger.js";
import { activeRequestKey } from "./requestContext.js";

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
      const context = callbackArgs[callbackArgs.length - 1] as
        | ServerContext
        | undefined;
      const requestId = context?.mcpReq.id;
      const traceId = requestTraceId(context) ?? randomUUID().replaceAll("-", "");
      const protocolEra = context?.mcpReq.envelope ? 2026 : 2025;
      const clientKey = shortHash(activeRequestKey("unknown"));
      const inputTaskId = taskIdFrom(callbackArgs[0]);
      try {
        const result = await callback(...callbackArgs);
        const isError =
          typeof result === "object" &&
          result !== null &&
          (result as { isError?: unknown }).isError === true;
        const parsed = parseResult(resultText(result));
        logger.info("mcp.tool_call", {
          protocolEra,
          requestId,
          traceId,
          toolName,
          clientKey,
          taskCorrelation: taskCorrelation(inputTaskId ?? taskIdFrom(parsed)),
          durationMs: Date.now() - startedAt,
          outcome: isError ? "error" : outcome(parsed),
          errorCode: isError ? errorCode(parsed) : undefined,
        });
        return result;
      } catch (error) {
        logger.error("mcp.tool_call", {
          protocolEra,
          requestId,
          traceId,
          toolName,
          clientKey,
          taskCorrelation: taskCorrelation(inputTaskId),
          durationMs: Date.now() - startedAt,
          outcome: "exception",
          errorCode: error instanceof Error ? error.name : "unknown",
        });
        throw error;
      }
    };
    return original(...registrationArgs);
  };
}

function parseResult(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function outcome(result: Record<string, unknown> | null): string {
  return typeof result?.status === "string" ? result.status : "success";
}

function errorCode(result: Record<string, unknown> | null): string {
  return typeof result?.code === "string" ? result.code : "tool_error";
}

function taskIdFrom(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const taskId = (value as Record<string, unknown>).taskId;
  return typeof taskId === "string" && /^[A-Za-z0-9_-]{43}$/.test(taskId)
    ? taskId
    : null;
}

function taskCorrelation(taskId: string | null): string | undefined {
  return taskId ? shortHash(taskId) : undefined;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function requestTraceId(context: ServerContext | undefined): string | null {
  const metadata = context?.mcpReq._meta as
    | Record<string, unknown>
    | undefined;
  const envelope = context?.mcpReq.envelope as
    | Record<string, unknown>
    | undefined;
  const raw =
    metadata?.[TRACEPARENT_META_KEY] ??
    envelope?.[TRACEPARENT_META_KEY] ??
    context?.http?.req?.headers.get("traceparent");
  if (typeof raw !== "string") return null;
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(raw);
  return match?.[1]?.toLowerCase() ?? null;
}
