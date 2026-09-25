import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response } from "express";
import { clientAddress } from "../http/edgeBoundary.js";

interface McpRequestContext {
  signal: AbortSignal;
  clientKey: string;
}

const requestContexts = new AsyncLocalStorage<McpRequestContext>();

export async function withRequestDisconnectSignal<T>(
  req: Request,
  res: Response,
  action: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIfIncomplete = () => {
    if (!res.writableFinished) abort();
  };
  req.once("aborted", abort);
  res.once("close", abortIfIncomplete);
  try {
    return await requestContexts.run(
      {
        signal: controller.signal,
        clientKey: clientAddress(req),
      },
      action,
    );
  } finally {
    req.off("aborted", abort);
    res.off("close", abortIfIncomplete);
  }
}

/**
 * Puts the request's client key in scope for a plain HTTP route, without the
 * disconnect signal: the sites that charge signature-verification admission
 * read it through `activeRequestKey` whichever surface the request came in
 * on. A context already in scope (the MCP transport's) is kept.
 */
export function withRequestClientKey<T>(req: Request, action: () => T): T {
  if (requestContexts.getStore()) return action();
  return requestContexts.run(
    {
      signal: new AbortController().signal,
      clientKey: clientAddress(req),
    },
    action,
  );
}

export function activeRequestSignal(fallback: AbortSignal): AbortSignal {
  const requestSignal = requestContexts.getStore()?.signal;
  return requestSignal
    ? AbortSignal.any([fallback, requestSignal])
    : fallback;
}

export function activeRequestKey(fallback: string): string {
  return requestContexts.getStore()?.clientKey ?? fallback;
}
