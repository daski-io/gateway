import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import type { StoredChallenge } from "../types.js";
import { buildEnvelopeAuth } from "../auth/envelope.js";
import { normalizeState } from "../util/a2aShape.js";
import { a2aPostJson, providerErrorFromFailure, type Fetcher } from "./a2a.js";
import {
  sanitizeProviderArtifacts,
  sanitizeProviderValue,
} from "./providerReflection.js";
import { extractReplyPolicy } from "./replyPolicy.js";
import { mapProviderRpcError } from "./rpcErrors.js";
import type { SubmitTaskArgs } from "./submitTaskTypes.js";
import {
  mcpError,
  mcpJson,
  type McpToolResult,
} from "./util.js";

interface SubmitTaskTransport {
  fetch: Fetcher;
  timeoutMs: number;
  maxResponseBytes: number;
}

interface DispatchInput {
  args: SubmitTaskArgs;
  paidChallenge: StoredChallenge | null;
  config: Config;
  transport: SubmitTaskTransport;
}

type SubmitRpc = {
  error?: { code?: number; message?: string; data?: unknown };
  result?: {
    id?: string;
    contextId?: string;
    status?: {
      state?: string;
      message?: { role?: string; parts?: unknown[] } | unknown;
    };
    artifacts?: unknown[];
  };
};

function inputError(code: string, message: string): McpToolResult {
  return mcpError({ code, message });
}

/** Dispatches an authenticated task after local payment checks are complete. */
export async function dispatchSubmitTask({
  args,
  paidChallenge,
  config,
  transport,
}: DispatchInput): Promise<McpToolResult> {
  const parts: Array<Record<string, unknown>> = [
    args.prompt
      ? { kind: "text", text: args.prompt }
      : { kind: "text", text: `Execute skill ${args.skillId}` },
  ];
  if (args.serviceArgs && Object.keys(args.serviceArgs).length > 0) {
    parts.push({ kind: "data", data: args.serviceArgs });
  }

  const metadata: Record<string, unknown> = {
    skillId: args.skillId,
    paymentId: args.paymentId,
    chainId: args.chainId,
  };
  if (args.serviceRef) metadata.serviceRef = args.serviceRef;
  if (args.transactionHash) metadata.transactionHash = args.transactionHash;
  if (args.taskId) metadata.taskId = args.taskId;
  if (args.capability) metadata.capability = args.capability;
  if (args.envelopeAuth) metadata.envelopeAuth = args.envelopeAuth;
  if (paidChallenge) {
    metadata.quoteId = paidChallenge.quoteId;
    metadata.quoteSignature = paidChallenge.quoteSignature;
  }

  if (args.envelopeAuth && !args.messageId) {
    return inputError(
      "MESSAGE_ID_REQUIRED",
      "messageId must be supplied alongside envelopeAuth so the A2A " +
        "envelope matches what the buyer signed. Pass the same messageId " +
        "returned by the first (no-envelopeAuth) call.",
    );
  }
  if (
    args.envelopeAuth &&
    args.messageId &&
    args.envelopeAuth.authorization.messageId !== args.messageId
  ) {
    return inputError(
      "MESSAGE_ID_MISMATCH",
      `envelopeAuth.authorization.messageId=${args.envelopeAuth.authorization.messageId} ` +
        `but submit_task messageId=${args.messageId}. They must match.`,
    );
  }

  const messageId = args.messageId ?? randomUUID();
  const contextId = args.contextId ?? randomUUID();
  const body = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "SendMessage",
    params: {
      message: {
        role: "ROLE_USER",
        parts,
        messageId,
        contextId,
        metadata: { [DASKI_A2A_EXTENSION_URI]: metadata },
      },
    },
  };

  const post = await a2aPostJson<SubmitRpc>(args.providerA2AUrl, body, {
    fetch: transport.fetch,
    timeoutMs: transport.timeoutMs,
    maxBytes: transport.maxResponseBytes,
    failOnNonOk: true,
  });
  if (!post.ok) {
    return providerErrorFromFailure(post, args.providerA2AUrl, {
      contextId,
      nextAction:
        "The request MAY have been processed before the failure and any " +
        "signed envelope is now consumed — do NOT re-send the same " +
        "envelope/messageId. First verify actual state with a read-only " +
        "skill. Only if the action did NOT take effect, request a FRESH " +
        "envelope and retry with the same contextId.",
    });
  }
  const rpc = post.body;
  if (rpc.error) {
    const mapped = mapProviderRpcError(rpc.error.code);
    return mcpError({
      code: mapped?.code ?? "PROVIDER_ERROR",
      message: sanitizeProviderValue(
        rpc.error.message ?? "JSON-RPC error",
      ) as string,
      details: {
        contextId,
        ...(rpc.error.code !== undefined ? { rpcCode: rpc.error.code } : {}),
        ...(rpc.error.data !== undefined
          ? { data: sanitizeProviderValue(rpc.error.data) }
          : {}),
      },
      ...(mapped?.recoverable !== undefined
        ? { recoverable: mapped.recoverable }
        : {}),
      ...(mapped?.nextAction ? { next_action: mapped.nextAction } : {}),
    });
  }
  if (!rpc.result?.id) {
    return mcpError({
      code: "PROVIDER_ERROR",
      message: "Provider response missing result.id",
      details: { contextId },
    });
  }

  const result = rpc.result;
  const status = normalizeState(result.status?.state) ?? "submitted";
  const flattened: Record<string, unknown> = {
    taskId: result.id,
    contextId: result.contextId ?? contextId,
    status,
    // Deprecated alias — older clients read `state`. Remove after a
    // deprecation window; `status` is the canonical key on every path.
    state: status,
    providerA2AUrl: args.providerA2AUrl,
  };
  if (Array.isArray(result.artifacts) && result.artifacts.length > 0) {
    flattened.artifacts = sanitizeProviderArtifacts(result.artifacts);
  }
  if (result.status?.message) {
    flattened.statusMessage = sanitizeProviderValue(result.status.message);
    const replyPolicy = extractReplyPolicy(result.status.message);
    if (replyPolicy) flattened.replyPolicy = replyPolicy;
  }

  const capabilityChallengeReturned =
    status === "input-required" &&
    Array.isArray(result.artifacts) &&
    result.artifacts.some(
      (artifact) =>
        artifact !== null &&
        typeof artifact === "object" &&
        (artifact as Record<string, unknown>).name === "capability_challenge",
    );
  if (capabilityChallengeReturned && args.envelopeAuth) {
    const nextEnvelope = buildEnvelopeAuth({
      skillId: args.skillId,
      paymentId: args.paymentId,
      chainId: args.chainId,
      buyerTokenId: args.envelopeAuth.authorization.buyerTokenId,
      identityRegistryAddress: config.identityRegistryAddress,
      serviceArgs: args.serviceArgs ?? {},
    });
    flattened.nextEnvelopeAuthChallenge = {
      messageId: nextEnvelope.messageId,
      requestHash: nextEnvelope.requestHash,
      issuedAt: nextEnvelope.issuedAt,
      authorization: nextEnvelope.authorization,
      eip712TypedData: nextEnvelope.eip712TypedData,
      hint:
        "Envelopes are single-use: the execute call needs THIS fresh " +
        "envelope. Sign the capability challenge and this typed data, then " +
        "call daski_submit_task again with the returned contextId.",
    };
  }
  return mcpJson(flattened);
}
