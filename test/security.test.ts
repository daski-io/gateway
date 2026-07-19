import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { rateLimit } from "../src/util/security.js";

function responseStub() {
  const headers = new Map<string, string>();
  return {
    headers,
    response: {
      setHeader: (name: string, value: string) => headers.set(name, value),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response,
  };
}

describe("rateLimit", () => {
  it("uses the shared store and rejects requests over budget", async () => {
    const consumeRateLimitBucket = vi
      .fn()
      .mockResolvedValueOnce({ count: 1, resetAt: new Date(Date.now() + 1000) })
      .mockResolvedValueOnce({ count: 2, resetAt: new Date(Date.now() + 1000) });
    const middleware = rateLimit({
      windowMs: 1000,
      max: 1,
      namespace: "test",
      store: { consumeRateLimitBucket },
    });
    const request = {
      ip: "203.0.113.7",
      socket: {},
    } as Request;
    const next = vi.fn() as unknown as NextFunction;

    const first = responseStub();
    middleware(request, first.response, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());

    const second = responseStub();
    middleware(request, second.response, next);
    await vi.waitFor(() =>
      expect(second.response.status).toHaveBeenCalledWith(429),
    );
    expect(consumeRateLimitBucket).toHaveBeenCalledWith(
      "test:203.0.113.7",
      1000,
    );
  });

  it("uses one shared key for a global budget", async () => {
    const consumeRateLimitBucket = vi.fn().mockResolvedValue({
      count: 1,
      resetAt: new Date(Date.now() + 1000),
    });
    const middleware = rateLimit({
      windowMs: 1000,
      max: 2,
      namespace: "global-test",
      keyScope: "global",
      store: { consumeRateLimitBucket },
    });
    const request = {
      ip: "203.0.113.7",
      socket: {},
    } as Request;
    const next = vi.fn() as unknown as NextFunction;
    middleware(request, responseStub().response, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(consumeRateLimitBucket).toHaveBeenCalledWith(
      "global-test:global",
      1000,
    );
  });
});
