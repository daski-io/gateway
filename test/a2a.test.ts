import { describe, expect, it } from "vitest";
import { a2aPostJson } from "../src/mcp/a2a.js";

function stalledResponse(signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () =>
          controller.error(
            new DOMException("The operation was aborted", "AbortError"),
          ),
        { once: true },
      );
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("A2A JSON transport", () => {
  it("keeps the timeout active while reading the response body", async () => {
    const fetchFn = async (_url: string, init?: RequestInit) =>
      stalledResponse(init?.signal as AbortSignal);

    const result = await a2aPostJson("https://provider.test/a2a", {}, {
      fetch: fetchFn,
      timeoutMs: 10,
      maxBytes: 1024,
    });

    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("distinguishes invalid JSON from oversized responses", async () => {
    const result = await a2aPostJson("https://provider.test/a2a", {}, {
      fetch: async () => new Response("not JSON", { status: 200 }),
      timeoutMs: 100,
      maxBytes: 1024,
    });

    expect(result).toMatchObject({ ok: false, reason: "non_json" });
  });
});
