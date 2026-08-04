import { randomUUID } from "node:crypto";
import { normalizeRole, normalizeState } from "../util/a2aShape.js";
import { a2aPostJson, providerErrorFromFailure, type Fetcher } from "./a2a.js";
import { mcpActionRequired, mcpError, mcpJson, type McpToolResult } from "./util.js";
import { sanitizeProviderValue } from "./providerReflection.js";
import { mapProviderRpcError } from "./rpcErrors.js";

interface PollTaskStatusArgs {
  providerA2AUrl: string;
  taskId: string;
  providerTaskId: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  capability?: {
    signature: string;
    authorization: Record<string, unknown>;
  };
  taskAccessToken?: string;
}

export interface TaskStatusTransport {
  fetch: Fetcher;
  timeoutMs: number;
  maxResponseBytes: number;
}

interface CheckRpc {
  error?: { code?: number; message?: string; data?: unknown };
  result?: {
    id?: string;
    contextId?: string;
    status?: {
      state?: string;
      message?: { role?: string; parts?: Array<Record<string, unknown>> };
    };
    artifacts?: Array<{
      name?: string;
      parts?: Array<Record<string, unknown>>;
    }>;
  };
}

interface StatusMessage {
  role?: string;
  parts?: Array<Record<string, unknown>>;
}

export async function pollTaskStatus(
  args: PollTaskStatusArgs,
  transport: TaskStatusTransport,
): Promise<McpToolResult> {
  const body = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "GetTask",
    params: {
      id: args.providerTaskId,
      ...(args.capability ? { capability: args.capability } : {}),
      ...(args.taskAccessToken
        ? { taskAccessToken: args.taskAccessToken }
        : {}),
    },
  };
  const post = await a2aPostJson<CheckRpc>(args.providerA2AUrl, body, {
    fetch: transport.fetch,
    timeoutMs: transport.timeoutMs,
    maxBytes: transport.maxResponseBytes,
    failOnNonOk: true,
  });
  if (!post.ok) {
    return providerErrorFromFailure(post, args.providerA2AUrl);
  }
  if (post.body.error) {
    const rpcError = post.body.error;
    const mapped = mapProviderRpcError(rpcError.code);
    const untrustedProviderContent = {
      message: sanitizeProviderValue(
        rpcError.message ?? "JSON-RPC error",
      ) as string,
      ...(rpcError.data !== undefined
        ? { data: sanitizeProviderValue(rpcError.data) }
        : {}),
    };
    const payload = {
      code: mapped?.code ?? "PROVIDER_ERROR",
      ...(mapped?.recoverable !== undefined
        ? { recoverable: mapped.recoverable }
        : {}),
      ...(mapped?.nextAction ? { next_action: mapped.nextAction } : {}),
      message: mapped
        ? `Provider returned ${mapped.code}.`
        : "Provider returned an error.",
      ...(rpcError.code !== undefined || rpcError.data !== undefined
        ? {
            details: {
              ...(rpcError.code !== undefined ? { rpcCode: rpcError.code } : {}),
              untrustedProviderContent,
            },
          }
        : { details: { untrustedProviderContent } }),
    };
    // Authorization steps are expected transitions, not failures.
    if (mapped?.actionRequired) {
      return mcpActionRequired(mapped.actionRequired, payload);
    }
    return mcpError(payload);
  }
  const result = post.body.result;
  if (!result) {
    return mcpError({
      code: "PROVIDER_ERROR",
      message: "Provider response missing result",
    });
  }
  const resolvedStatus = normalizeState(result.status?.state) ?? "unknown";
  if (
    typeof result.id === "string" &&
    result.id !== args.providerTaskId
  ) {
    return mcpError({
      code: "PROVIDER_TASK_ID_MISMATCH",
      message: "Provider returned a different task identifier than requested.",
    });
  }
  const extractedArtifacts = extractArtifacts(
    result.artifacts ?? [],
  );
  return mcpJson({
    taskId: args.taskId,
    contextId: result.contextId ?? null,
    status: resolvedStatus,
    createdAt: args.createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: args.expiresAt.toISOString(),
    untrustedProviderContent: {
      artifacts: extractedArtifacts,
      messages: extractMessages(result.status?.message),
    },
  });
}

function extractArtifacts(
  source: NonNullable<CheckRpc["result"]>["artifacts"],
): Array<Record<string, unknown>> {
  const artifacts: Array<Record<string, unknown>> = [];
  for (const artifact of source ?? []) {
    for (const part of artifact.parts ?? []) {
      if (part.kind === "file" && isRecord(part.file)) {
        const file = part.file;
        if (typeof file.url === "string") {
          artifacts.push({
            type: "file",
            name: sanitizeProviderValue(artifact.name ?? file.name ?? "(unnamed)"),
            url: file.url,
            mimeType: sanitizeProviderValue(file.mimeType),
          });
        } else if (typeof file.bytes === "string") {
          artifacts.push({
            type: "file",
            name: sanitizeProviderValue(artifact.name ?? file.name ?? "(unnamed)"),
            bytes: file.bytes,
            encoding: "base64",
            mimeType: sanitizeProviderValue(file.mimeType),
          });
        }
      } else if (part.kind === "data" && part.data != null) {
        artifacts.push({
          type: "data",
          name: sanitizeProviderValue(artifact.name ?? "(unnamed)"),
          data: sanitizeProviderValue(part.data),
        });
      }
    }
  }
  return artifacts;
}

function extractMessages(message: StatusMessage | undefined): Array<Record<string, unknown>> {
  if (!message) return [];
  const messages: Array<Record<string, unknown>> = [];
  const role = normalizeRole(message.role) ?? "agent";
  for (const part of message.parts ?? []) {
    if (part.kind === "text" && typeof part.text === "string") {
      messages.push({
        role,
        content: sanitizeProviderValue(part.text),
      });
    } else if (part.kind === "data" && part.data != null) {
      messages.push({
        role,
        data: sanitizeProviderValue(part.data),
      });
    }
  }
  return messages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
