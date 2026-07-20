import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  activeRequestKey,
  activeRequestSignal,
  withRequestDisconnectSignal,
} from "../src/mcp/requestContext.js";

describe("MCP request context", () => {
  it("aborts active tool work when the HTTP response disconnects", async () => {
    const request = Object.assign(new EventEmitter(), {
      ip: "198.51.100.7",
    }) as Request;
    const response = Object.assign(new EventEmitter(), {
      writableFinished: false,
    }) as Response;
    const fallback = new AbortController();
    let active: AbortSignal | undefined;

    const pending = withRequestDisconnectSignal(request, response, async () => {
      active = activeRequestSignal(fallback.signal);
      expect(activeRequestKey("fallback")).toBe("198.51.100.7");
      await new Promise<void>((resolve) =>
        active?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return active.aborted;
    });
    await vi.waitFor(() => expect(active).toBeDefined());
    response.emit("close");

    expect(await pending).toBe(true);
    expect(fallback.signal.aborted).toBe(false);
  });
});
