import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  activeRequestSignal,
  withRequestDisconnectSignal,
} from "../src/mcp/requestContext.js";
import { StandardProviderTransport } from "../src/standardRail/providerTransport.js";
import type { StandardListing } from "../src/standardRail/types.js";

function requestPair() {
  const req = Object.assign(new EventEmitter(), {
    ip: "203.0.113.1",
    socket: { remoteAddress: "203.0.113.1" },
  }) as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false,
  }) as unknown as Response;
  return { req, res };
}

describe("request disconnect context", () => {
  it("combines the request disconnect with an operation timeout", async () => {
    const { req, res } = requestPair();
    const timeout = new AbortController();
    let combined: AbortSignal | undefined;

    await withRequestDisconnectSignal(req, res, async () => {
      combined = activeRequestSignal(timeout.signal);
      expect(combined.aborted).toBe(false);
      (req as unknown as EventEmitter).emit("aborted");
      expect(combined.aborted).toBe(true);
    });

    expect(timeout.signal.aborted).toBe(false);
  });

  it("passes the combined signal only for request-scoped provider work", async () => {
    const { req, res } = requestPair();
    let captured: AbortSignal | null | undefined;
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init?.signal;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const transport = new StandardProviderTransport(fetchFn);
    const listing = {
      providerControlProfile: {
        payload: { origin: "https://8.8.8.8" },
      },
    } as unknown as StandardListing;

    await withRequestDisconnectSignal(req, res, async () => {
      await transport.fetch(
        listing,
        "https://8.8.8.8/card",
        { signal: AbortSignal.timeout(10_000) },
        { requestScoped: true },
      );
      expect(captured?.aborted).toBe(false);
      (req as unknown as EventEmitter).emit("aborted");
      expect(captured?.aborted).toBe(true);
    });
  });
});
