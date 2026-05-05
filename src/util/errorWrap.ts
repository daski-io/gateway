import { randomUUID } from "node:crypto";

// Logs a server-side error and returns a short correlation id that's safe
// to surface to the client. Replaces the previous pattern of echoing
// `(err as Error).message` directly to clients — for chain reads that's
// often a verbatim viem/RPC string that fingerprints the contract version,
// the RPC provider, or the upstream error path. Operators can grep logs
// by correlation id when a user reports a failure.

export function logErrorWithId(context: string, err: unknown): string {
  const correlationId = randomUUID();
  // eslint-disable-next-line no-console
  console.error(`[${context} ${correlationId}]`, err);
  return correlationId;
}
