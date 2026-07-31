import {
  buildTaskAccessChallenge,
  verifyTaskAccessCapability,
} from "../auth/taskAccess.js";
import type { McpDeps } from "./server.js";
import type { CatalogA2AEndpoint } from "./providerCatalog.js";
import { mcpActionRequired, mcpError, type McpToolResult } from "./util.js";

const ANONYMOUS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface TaskStatusInput {
  providerA2AUrl: string;
  taskId: string;
  capability?: {
    signature: string;
    authorization: Record<string, unknown>;
  };
  taskAccessToken?: string;
  stream?: boolean;
  streamingTimeoutMs?: number;
}

type AdmissionResult =
  | { ok: true; args: TaskStatusInput }
  | { ok: false; result: McpToolResult };

export async function admitTaskStatus(
  args: TaskStatusInput,
  endpoint: CatalogA2AEndpoint,
  deps: McpDeps,
): Promise<AdmissionResult> {
  let mapping;
  try {
    mapping = await deps.queries.completedTaskMapping(endpoint.url, args.taskId);
  } catch {
    return refused(
      "TASK_MAPPING_LOOKUP_FAILED",
      "The gateway could not verify this task's dispatch binding.",
      true,
    );
  }
  if (!mapping) {
    return refused(
      "TASK_NOT_MAPPED",
      "No completed gateway dispatch matches this provider and task.",
      false,
    );
  }
  if (mapping.providerA2AUrl !== endpoint.url) {
    return refused(
      "TASK_MAPPING_INTEGRITY",
      "The stored provider binding is inconsistent.",
      false,
    );
  }

  if (mapping.buyerTokenId === 0n) {
    if (args.capability) {
      return refused(
        "TASK_AUTHORIZATION_MISMATCH",
        "Anonymous tasks use taskAccessToken, not a buyer capability.",
        false,
      );
    }
    if (
      !args.taskAccessToken ||
      !ANONYMOUS_TOKEN_PATTERN.test(args.taskAccessToken)
    ) {
      return refused(
        "TASK_ACCESS_TOKEN_REQUIRED",
        "A valid taskAccessToken from the anonymous submission response is required.",
        true,
      );
    }
    return {
      ok: true,
      args: { ...args, providerA2AUrl: mapping.providerA2AUrl },
    };
  }

  if (args.taskAccessToken) {
    return refused(
      "TASK_AUTHORIZATION_MISMATCH",
      "Buyer-bound tasks use a signed capability, not taskAccessToken.",
      false,
    );
  }
  if (!args.capability) {
    const challenge = buildTaskAccessChallenge(
      deps.config,
      mapping.buyerTokenId,
      endpoint.provider.agentId,
      mapping.taskId,
    );
    return {
      ok: false,
      result: mcpActionRequired("sign_task_access", {
        code: "TASK_AUTHORIZATION_REQUIRED",
        message:
          "Sign the task-bound EIP-712 authorization, then retry with capability.",
        requiresSignature: true,
        authorization: challenge.authorization,
        eip712TypedData: challenge.eip712TypedData,
        recoverable: true,
        next_action:
          "Sign eip712TypedData with the buyer agent wallet and retry using the authorization verbatim.",
      }),
    };
  }

  const verified = await verifyTaskAccessCapability(
    deps.config,
    deps.reader,
    args.capability,
    {
      buyerTokenId: mapping.buyerTokenId,
      providerAgentId: endpoint.provider.agentId,
      taskId: mapping.taskId,
    },
  );
  if (!verified.ok) {
    return refused(
      "TASK_AUTHORIZATION_REJECTED",
      `The task capability was rejected (${verified.code}).`,
      true,
    );
  }
  return {
    ok: true,
    args: { ...args, providerA2AUrl: mapping.providerA2AUrl },
  };
}

function refused(
  code: string,
  message: string,
  recoverable: boolean,
): AdmissionResult {
  return {
    ok: false,
    result: mcpError({
      code,
      message,
      recoverable,
      ...(recoverable
        ? {
            next_action:
              "Retry with the exact provider, task, and required authorization.",
          }
        : {}),
    }),
  };
}
