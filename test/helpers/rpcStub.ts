// A fetch stand-in for viem's HTTP transport: every request is answered
// offline, so the errors under test are the exact objects viem builds from a
// node's JSON-RPC error, an HTTP failure or a timeout. Nothing reaches a
// network.

export interface StubbedRpcRequest {
  url: string;
  method: string;
  params: unknown[];
}

export type StubbedRpcReply =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
  | Response
  | Error
  | "hang";

export interface StubbedRpcFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  calls: StubbedRpcRequest[];
}

export function stubRpcFetch(
  reply: (request: StubbedRpcRequest) => StubbedRpcReply | Promise<StubbedRpcReply>,
): StubbedRpcFetch {
  const calls: StubbedRpcRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    const request = { url, method: body.method, params: body.params ?? [] };
    calls.push(request);
    const answer = await reply(request);
    if (answer === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...answer }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as StubbedRpcFetch;
  fetchFn.calls = calls;
  return fetchFn;
}

/** A JSON-RPC error body sent with a non-2xx status, as Infura answers a rate limit. */
export function jsonRpcErrorResponse(
  status: number,
  error: { code: number; message: string; data?: unknown },
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export const INTERNAL_ERROR = { error: { code: -32603, message: "Internal error" } } as const;
