import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";

// Logs a server-side error and returns a short correlation id that's safe
// to surface to the client. Replaces the previous pattern of echoing
// `(err as Error).message` directly to clients — for chain reads that's
// often a verbatim viem/RPC string that fingerprints the contract version,
// the RPC provider, or the upstream error path. Operators can grep logs
// by correlation id when a user reports a failure.

export function logErrorWithId(
  context: string,
  err: unknown,
  fields: Record<string, unknown> = {},
): string {
  const correlationId = randomUUID();
  logger.error(`${context} failed`, {
    correlationId,
    ...fields,
    error: err instanceof Error ? err : { name: "NonErrorThrown" },
  });
  return correlationId;
}

export function publicErrorMessage(
  context: string,
  err: unknown,
  message: string,
): string {
  const correlationId = logErrorWithId(context, err);
  return `${message} (reference: ${correlationId})`;
}
