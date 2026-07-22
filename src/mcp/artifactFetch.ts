import { createHash } from "node:crypto";
import { readBoundedBody, UrlSafetyError } from "../util/urlSafety.js";
import { mcpError, mcpJson, type McpToolResult } from "./util.js";
import {
  challengeResponse,
  extractChallenge,
  mediaType,
  parseFilename,
  parseJson,
  validateCapability,
  type ArtifactCapability,
} from "./artifactProtocol.js";
import { sanitizeProviderValue } from "./providerReflection.js";

const ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;
const ERROR_MAX_BYTES = 64 * 1024;
const CAPABILITY_HEADER = "X-Daski-Task-Capability";

export interface ArtifactFetchArgs {
  url: string;
  providerA2AUrl: string;
  taskId: string;
  expectedMimeType?: string;
  capability?: ArtifactCapability;
}

export interface ArtifactFetchOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs: number;
}

interface ActiveResponse {
  response: Response;
  clearTimeout(): void;
}

function readErrorCode(error: unknown, fallback: string): string {
  if (error instanceof UrlSafetyError) return error.code;
  return (error as Error).name === "AbortError" ? "ARTIFACT_TIMEOUT" : fallback;
}

async function artifactErrorResponse(res: Response): Promise<McpToolResult> {
  let details: Record<string, unknown> = { status: res.status };
  try {
    const body = parseJson(await readBoundedBody(res, ERROR_MAX_BYTES));
    if (body !== null) {
      details = { ...details, body: sanitizeProviderValue(body) };
    }
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return mcpError({
        code: "ARTIFACT_TIMEOUT",
        message: "Artifact response body timed out.",
        recoverable: true,
      });
    }
    // The HTTP status remains sufficient when the bounded error body is unreadable.
  }
  return mcpError({
    code: "ARTIFACT_FETCH_FAILED",
    message: `Artifact server returned HTTP ${res.status}.`,
    details,
    recoverable: res.status >= 500,
  });
}

async function getArtifactResponse(
  args: ArtifactFetchArgs,
  options: ArtifactFetchOptions,
  requestSignal?: AbortSignal,
): Promise<ActiveResponse | McpToolResult> {
  const controller = new AbortController();
  const onRequestAbort = () => controller.abort();
  if (requestSignal?.aborted) onRequestAbort();
  else requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    requestSignal?.removeEventListener("abort", onRequestAbort);
  };
  try {
    const headers = new Headers({
      Accept: args.expectedMimeType ?? "application/pdf",
    });
    if (args.capability) {
      headers.set(
        CAPABILITY_HEADER,
        Buffer.from(JSON.stringify(args.capability), "utf8").toString("base64url"),
      );
    }
    const response = await options.fetch(args.url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    return { response, clearTimeout: cleanup };
  } catch (error) {
    cleanup();
    const requestCancelled = requestSignal?.aborted === true;
    const timedOut = controller.signal.aborted;
    return mcpError({
      code:
        requestCancelled
          ? "REQUEST_CANCELLED"
          : error instanceof UrlSafetyError
          ? error.code
          : timedOut
            ? "ARTIFACT_TIMEOUT"
            : "ARTIFACT_UNREACHABLE",
      message: timedOut
        ? requestCancelled
          ? "Artifact retrieval cancelled by the client."
          : `Artifact GET timed out after ${options.timeoutMs}ms.`
        : `Artifact GET failed: ${(error as Error).message}`,
      recoverable: true,
    });
  }
}

function isActiveResponse(value: ActiveResponse | McpToolResult): value is ActiveResponse {
  return "response" in value;
}

async function readArtifact(
  res: Response,
  args: ArtifactFetchArgs,
  requestSignal?: AbortSignal,
): Promise<McpToolResult> {
  const expected = mediaType(args.expectedMimeType ?? "application/pdf");
  const actual = mediaType(res.headers.get("content-type"));
  if (!actual || actual !== expected) {
    await res.body?.cancel().catch(() => undefined);
    return mcpError({
      code: "ARTIFACT_CONTENT_TYPE_MISMATCH",
      message:
        `Expected Content-Type ${expected ?? "(invalid)"}, received ` +
        `${actual ?? "(missing)"}. No artifact bytes were returned.`,
    });
  }
  try {
    const bytes = await readBoundedBody(res, ARTIFACT_MAX_BYTES);
    if (
      actual === "application/pdf" &&
      !new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")
    ) {
      return mcpError({
        code: "ARTIFACT_CONTENT_INVALID",
        message: "The response claimed application/pdf but did not contain a PDF header.",
      });
    }
    const base64 = Buffer.from(bytes).toString("base64");
    const filename = parseFilename(res.headers.get("content-disposition"));
    const result = mcpJson({
      taskId: args.taskId,
      artifact: {
        mimeType: actual,
        filename,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      delivery: {
        principalUsable: true,
        kind: "embedded_file",
        filename: filename ?? "artifact",
        note:
          "The document is attached to this result as an MCP embedded " +
          "resource — a real file, not just JSON. Hand that file to your " +
          "principal; retrieval alone is not delivery.",
      },
    });
    // The embedded resource is the single byte-bearing representation.
    result.content.push({
      type: "resource",
      resource: {
        uri:
          `daski-artifact://${encodeURIComponent(args.taskId)}/` +
          encodeURIComponent(filename ?? "artifact"),
        mimeType: actual,
        blob: base64,
      },
    });
    return result;
  } catch (error) {
    if (requestSignal?.aborted) {
      return mcpError({
        code: "REQUEST_CANCELLED",
        message: "Artifact retrieval cancelled by the client.",
        recoverable: true,
      });
    }
    return mcpError({
      code: readErrorCode(error, "ARTIFACT_READ_FAILED"),
      message: `Could not read artifact bytes: ${(error as Error).message}`,
      recoverable: (error as Error).name === "AbortError",
    });
  }
}

export async function fetchArtifact(
  args: ArtifactFetchArgs,
  options: ArtifactFetchOptions,
  requestSignal?: AbortSignal,
): Promise<McpToolResult> {
  if (args.capability) {
    const invalid = validateCapability(args.capability, args.taskId, args.url);
    if (invalid) return invalid;
  }
  const result = await getArtifactResponse(args, options, requestSignal);
  if (!isActiveResponse(result)) return result;
  const res = result.response;
  try {
    if (res.status === 401 || res.status === 403) {
      try {
        const body = parseJson(await readBoundedBody(res, ERROR_MAX_BYTES));
        const challenge = extractChallenge(body);
        if (challenge) {
          return challengeResponse(challenge, args.taskId, args.url, !!args.capability);
        }
      } catch (error) {
        return mcpError({
          code: readErrorCode(error, "ARTIFACT_AUTH_FAILED"),
          message: `Could not read artifact challenge: ${(error as Error).message}`,
          recoverable: (error as Error).name === "AbortError",
        });
      }
      return mcpError({
        code: "ARTIFACT_AUTH_FAILED",
        message:
          "Artifact server required authorization but returned no usable " + "capabilityChallenge.",
      });
    }
    if (!res.ok) return artifactErrorResponse(res);
    return readArtifact(res, args, requestSignal);
  } finally {
    result.clearTimeout();
  }
}
