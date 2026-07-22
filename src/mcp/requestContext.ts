import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response } from "express";

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
        clientKey: req.ip ?? req.socket?.remoteAddress ?? "unknown",
      },
      action,
    );
  } finally {
    req.off("aborted", abort);
    res.off("close", abortIfIncomplete);
  }
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
