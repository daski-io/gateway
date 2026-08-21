export interface RpcEndpoint<Client> {
  host: string;
  client: Client;
}

interface RpcFailoverOptions {
  attempts?: number;
  baseDelayMs?: number;
  onFallback?: (detail: { primaryHost: string; selectedHost: string }) => void;
}

function failureSummary(host: string, attempts: number, error: unknown): Error {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
  return new Error(
    host + " RPC observation failed after " + attempts + " attempts (" +
      name + (code ? " " + code : "") + ")",
  );
}

export async function withRpcFailover<Endpoint extends RpcEndpoint<unknown>, Result>(
  endpoints: readonly Endpoint[],
  observe: (endpoint: Endpoint) => Promise<Result>,
  options: RpcFailoverOptions = {},
): Promise<Result> {
  if (endpoints.length === 0) throw new Error("At least one RPC endpoint is required");
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("RPC attempts must be a positive integer");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error("RPC retry delay must be a non-negative number");
  }

  const failures: Error[] = [];
  for (const [endpointIndex, endpoint] of endpoints.entries()) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await observe(endpoint);
        if (endpointIndex > 0) {
          options.onFallback?.({
            primaryHost: endpoints[0]!.host,
            selectedHost: endpoint.host,
          });
        }
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < attempts && baseDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
        }
      }
    }
    failures.push(failureSummary(endpoint.host, attempts, lastError));
  }
  throw new AggregateError(
    failures,
    "RPC observation failed on the primary and every configured fallback",
  );
}
