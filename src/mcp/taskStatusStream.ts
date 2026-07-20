import { randomUUID } from "node:crypto";
import { normalizeState } from "../util/a2aShape.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import { readBoundedJson } from "../util/urlSafety.js";
import { guardProviderUrl, type Fetcher } from "./a2a.js";
import { mcpError, mcpJson, type McpToolResult } from "./util.js";
import { sanitizeProviderTaskEvent, sanitizeProviderValue } from "./providerReflection.js";

const STREAM_MAX_BYTES = 4 * 1024 * 1024;
const STREAM_MAX_EVENTS = 1000;
const STREAM_MIN_TIMEOUT_MS = 1_000;
const STREAM_MAX_TIMEOUT_MS = 120_000;

interface StreamTaskStatusArgs {
  providerA2AUrl: string;
  taskId: string;
  capability?: {
    signature: string;
    authorization: Record<string, unknown>;
  };
  streamingTimeoutMs?: number;
}

export interface ProgressSink {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification(payload: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      message: string;
    };
  }): Promise<void>;
}

export interface StreamTaskStatusTransport {
  fetch: Fetcher;
  enforceUrlSafety: boolean;
  maxResponseBytes: number;
}

export async function streamTaskStatus(
  args: StreamTaskStatusArgs,
  extra: ProgressSink,
  transport: StreamTaskStatusTransport,
): Promise<McpToolResult> {
  const guard = await guardProviderUrl(args.providerA2AUrl, transport.enforceUrlSafety);
  if (guard) return guard;

  const timeoutMs = args.streamingTimeoutMs ?? STREAM_MAX_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < STREAM_MIN_TIMEOUT_MS ||
    timeoutMs > STREAM_MAX_TIMEOUT_MS
  ) {
    return mcpError({
      code: "BAD_INPUT",
      message: "streamingTimeoutMs must be an integer from 1000 to 120000.",
    });
  }
  const controller = new AbortController();
  let abortReason: "timeout" | "client" | null = null;
  const abort = (reason: "timeout" | "client") => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort();
  };
  const timer = setTimeout(() => abort("timeout"), timeoutMs);
  const onClientAbort = () => abort("client");
  if (extra.signal?.aborted) onClientAbort();
  else extra.signal?.addEventListener("abort", onClientAbort, { once: true });
  const cleanupAbort = () => {
    clearTimeout(timer);
    extra.signal?.removeEventListener("abort", onClientAbort);
  };
  let response: Response;
  try {
    response = await transport.fetch(args.providerA2AUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "SubscribeToTask",
        params: {
          id: args.taskId,
          ...(args.capability ? { capability: args.capability } : {}),
        },
      }),
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (error) {
    cleanupAbort();
    return mcpError({
      code:
        abortReason === "client"
          ? "REQUEST_CANCELLED"
          : (error as { name?: string }).name === "AbortError"
            ? "streaming_timeout"
            : "PROVIDER_UNREACHABLE",
      message:
        abortReason === "client"
          ? "Task-status stream cancelled by the client."
          : `Provider unreachable at ${args.providerA2AUrl}`,
      recoverable: true,
      next_action: "Retry streaming or use daski_get_task_status with stream:false.",
    });
  }

  if (!response.ok) {
    cleanupAbort();
    return unsupported(`Provider returned HTTP ${response.status} on SubscribeToTask`, {
      status: response.status,
      providerA2AUrl: args.providerA2AUrl,
    });
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    return nonSseResponse(response, contentType, cleanupAbort, transport);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    cleanupAbort();
    return unsupported("Provider returned an empty SSE stream");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let eventCount = 0;
  let lastEvent: Record<string, unknown> | null = null;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value?.byteLength ?? 0;
      if (bytes > STREAM_MAX_BYTES) {
        return mcpError({
          code: "PROVIDER_RESPONSE_TOO_LARGE",
          message: `SSE stream exceeded ${STREAM_MAX_BYTES} bytes`,
          recoverable: true,
          next_action: "Use daski_get_task_status with stream:false.",
        });
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: EventBoundary | null;
      while ((boundary = findEventBoundary(buffer)) !== null) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = rawEvent
          .split(/\r\n|\r|\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const parsed = parseEvent(data);
        if (!parsed) continue;
        if (parsed.error) {
          return mcpError({
            code: "PROVIDER_ERROR",
            message: sanitizeProviderValue(parsed.error.message ?? "stream error"),
            ...(parsed.error.data !== undefined
              ? {
                  details: {
                    data: sanitizeProviderValue(parsed.error.data),
                  },
                }
              : {}),
          });
        }
        if (!parsed.result) continue;
        lastEvent = parsed.result;
        eventCount += 1;
        if (!(await emitProgress(extra, eventCount, parsed.result))) {
          abortReason = "client";
          return mcpError({
            code: "REQUEST_CANCELLED",
            message: "Task-status stream cancelled by the client.",
            recoverable: true,
          });
        }
        if (eventCount > STREAM_MAX_EVENTS) {
          return mcpError({
            code: "PROVIDER_TOO_MANY_EVENTS",
            message: `SSE stream exceeded ${STREAM_MAX_EVENTS} events`,
            recoverable: true,
            next_action: "Use daski_get_task_status with stream:false.",
          });
        }
        if (parsed.result.final === true) {
          return streamResult(args.taskId, parsed.result, eventCount, false);
        }
      }
    }
  } catch (error) {
    if ((error as { name?: string }).name !== "AbortError") {
      return mcpError({
        code: "PROVIDER_ERROR",
        message: publicErrorMessage("mcp.taskStatus.sse", error, "provider event stream failed"),
      });
    }
    if (abortReason === "client") {
      return mcpError({
        code: "REQUEST_CANCELLED",
        message: "Task-status stream cancelled by the client.",
        recoverable: true,
      });
    }
  } finally {
    cleanupAbort();
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed.
    }
  }
  return streamResult(args.taskId, lastEvent, eventCount, true);
}

type StreamEvent = {
  result?: Record<string, unknown>;
  error?: { message?: string; data?: unknown };
};

interface EventBoundary {
  index: number;
  length: number;
}

function findEventBoundary(buffer: string): EventBoundary | null {
  const match = /(?:(?:\r\n)|\r|\n){2}/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseEvent(data: string): StreamEvent | null {
  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    return null;
  }
}

async function nonSseResponse(
  response: Response,
  contentType: string,
  cleanupAbort: () => void,
  transport: StreamTaskStatusTransport,
): Promise<McpToolResult> {
  let rpc: { error?: { code?: number; message?: string } } = {};
  try {
    rpc = await readBoundedJson(response, transport.maxResponseBytes);
  } catch {
    // The generic unsupported response below covers malformed bodies.
  } finally {
    cleanupAbort();
  }
  return unsupported(
    sanitizeProviderValue(
      rpc.error?.message ?? `Provider returned non-SSE content-type: ${contentType}`,
    ),
  );
}

function unsupported(message: string, details?: Record<string, unknown>): McpToolResult {
  return mcpError({
    code: "streaming_unsupported",
    message,
    ...(details ? { details } : {}),
    recoverable: true,
    next_action: "Use daski_get_task_status with stream:false.",
  });
}

async function emitProgress(
  extra: ProgressSink,
  progress: number,
  event: Record<string, unknown>,
): Promise<boolean> {
  const token = extra._meta?.progressToken;
  if (token === undefined) return true;
  const status = isRecord(event.status) ? event.status : {};
  const state = normalizeState(typeof status.state === "string" ? status.state : undefined);
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress,
        message: state ? `state=${state}` : "update",
      },
    });
    return true;
  } catch {
    return false;
  }
}

function streamResult(
  taskId: string,
  event: Record<string, unknown> | null,
  eventCount: number,
  timedOut: boolean,
): McpToolResult {
  const status = event && isRecord(event.status) ? event.status : {};
  return mcpJson({
    taskId,
    contextId: event && typeof event.contextId === "string" ? event.contextId : null,
    state:
      normalizeState(typeof status.state === "string" ? status.state : undefined) ??
      (timedOut ? "unknown" : "completed"),
    finalEvent: sanitizeProviderTaskEvent(event),
    eventCount,
    ...(timedOut ? { timedOut: true } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
