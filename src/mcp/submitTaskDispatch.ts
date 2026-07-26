import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { Hex, StoredChallenge } from "../types.js";
import { buildEnvelopeAuth } from "../auth/envelope.js";
import { normalizeState } from "../util/a2aShape.js";
import { a2aPostJson, providerErrorFromFailure, type Fetcher } from "./a2a.js";
import {
  sanitizeProviderArtifacts,
  sanitizeProviderValue,
} from "./providerReflection.js";
import { mapProviderRpcError } from "./rpcErrors.js";
import type { SubmitTaskArgs } from "./submitTaskTypes.js";
import {
  mcpActionRequired,
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
  queries: Queries;
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
  queries,
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
  // Durable operation trace, written BEFORE the provider sees the request:
  // if the response (and with it the provider-assigned taskId) is lost to
  // a timeout, the contextId row still exists for recovery
  // (daski_get_task_status accepts contextId/serviceRef). Input resubmits
  // reference an existing task, so they only update the trace on success.
  if (!args.taskId) {
    try {
      await queries.insertTaskMapping({
        contextId,
        messageId,
        serviceRef:
          args.serviceRef && /^0x[0-9a-fA-F]{64}$/.test(args.serviceRef)
            ? (args.serviceRef.toLowerCase() as Hex)
            : null,
        providerA2AUrl: args.providerA2AUrl,
        skillId: args.skillId,
        buyerTokenId: args.buyerTokenId ?? null,
      });
    } catch {
      // Best-effort trace — never blocks a dispatch.
    }
  }
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
    // The lost-response loop is CLOSED for paid submits (provider ≥v0.15
    // deduplicates on the settled serviceRef + signed body + envelope
    // messageId: an identical re-send returns the existing task without
    // re-executing). Free-skill and capability envelopes stay single-use.
    return providerErrorFromFailure(post, args.providerA2AUrl, {
      contextId,
      nextAction: args.serviceRef
        ? "The provider may or may not have received this submit. " +
          "Re-sending the IDENTICAL call (same envelope, same messageId) " +
          "is SAFE for a paid submit: the provider deduplicates and " +
          "returns the existing task instead of re-executing. If the " +
          "re-send also fails, verify actual state with a read-only " +
          "skill before doing anything else."
        : "The request MAY have been processed before the failure and " +
          "this envelope is single-use — do NOT re-send the same " +
          "envelope/messageId for a free skill. Verify actual state with " +
          "a read-only skill; only if the action did NOT take effect, " +
          "request a FRESH envelope and retry with the same contextId.",
    });
  }
  const rpc = post.body;
  if (rpc.error) {
    const mapped = mapProviderRpcError(rpc.error.code);
    const payload = {
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
    };
    // Authorization steps are expected transitions, not failures.
    if (mapped?.actionRequired) {
      return mcpActionRequired(mapped.actionRequired, payload);
    }
    return mcpError(payload);
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
  if (typeof result.id === "string") {
    try {
      await queries.completeTaskMapping(
        result.contextId ?? contextId,
        result.id,
        status,
      );
    } catch {
      // Best-effort trace.
    }
  }
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
