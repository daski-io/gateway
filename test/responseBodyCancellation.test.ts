import { describe, expect, it } from "vitest";
import { AgentCardFetcher } from "../src/discovery/agentCardFetcher.js";
import { fetchAgentCard } from "../src/identity/fetch-agent-card.js";
import { validateProviderLegalReachability } from "../src/legal/onboarding.js";
import { a2aPostJson } from "../src/mcp/a2a.js";
import { streamTaskStatus } from "../src/mcp/taskStatusStream.js";
import { readBoundedBody } from "../src/util/urlSafety.js";

function trackedResponse(
  status: number,
  headers: Record<string, string> = {},
): { response: Response; wasCancelled(): boolean } {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
    { status, headers },
  );
  return { response, wasCancelled: () => cancelled };
}

describe("outbound response body cancellation", () => {
  it("cancels rejected A2A responses", async () => {
    const rejected = trackedResponse(503);

    await a2aPostJson("https://provider.example/a2a", {}, {
      fetch: async () => rejected.response,
      timeoutMs: 1_000,
      maxBytes: 1_024,
      failOnNonOk: true,
    });

    expect(rejected.wasCancelled()).toBe(true);
  });

  it("cancels discovery redirect responses before following them", async () => {
    const redirect = trackedResponse(302, {
      location: "https://provider.example/card.json",
    });
    let calls = 0;
    const fetcher = new AgentCardFetcher({
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? redirect.response
          : new Response(JSON.stringify({ name: "Provider" }));
      },
    });

    await expect(
      fetcher.fetchJson(
        "https://provider.example/registration.json",
        Date.now() + 1_000,
      ),
    ).resolves.toEqual({ name: "Provider" });
    expect(redirect.wasCancelled()).toBe(true);
  });

  it("cancels rejected discovery responses", async () => {
    const rejected = trackedResponse(503);
    const fetcher = new AgentCardFetcher({
      fetch: async () => rejected.response,
    });

    await expect(
      fetcher.fetchJson(
        "https://provider.example/registration.json",
        Date.now() + 1_000,
      ),
    ).rejects.toThrow("HTTP 503");
    expect(rejected.wasCancelled()).toBe(true);
  });

  it("cancels rejected buyer agent-card responses", async () => {
    const rejected = trackedResponse(503);

    await expect(
      fetchAgentCard("https://buyer.example/card.json", {
        ipfsGatewayUrl: "https://ipfs.example/ipfs/",
        fetchFn: async () => rejected.response,
      }),
    ).rejects.toMatchObject({ code: "AGENT_URI_FETCH_FAILED" });
    expect(rejected.wasCancelled()).toBe(true);
  });

  it("cancels rejected task-status stream responses", async () => {
    const rejected = trackedResponse(503);

    await streamTaskStatus(
      {
        providerA2AUrl: "https://provider.example/a2a",
        taskId: "task-1",
        providerTaskId: "task-1",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      },
      { sendNotification: async () => undefined },
      {
        fetch: async () => rejected.response,
        enforceUrlSafety: false,
        maxResponseBytes: 1_024,
      },
    );

    expect(rejected.wasCancelled()).toBe(true);
  });

  it("cancels rejected provider registration responses", async () => {
    const rejected = trackedResponse(503);

    await expect(
      validateProviderLegalReachability(
        "https://provider.example/registration.json",
        async () => rejected.response,
      ),
    ).rejects.toThrow("registration URL returned HTTP 503");
    expect(rejected.wasCancelled()).toBe(true);
  });

  it("cancels provider legal-link redirects before following them", async () => {
    const redirect = trackedResponse(302, {
      location: "https://provider.example/current-terms",
    });
    const legal = {
      legalName: "Provider LLC",
      termsUrl: "https://provider.example/terms",
      privacyUrl: "https://provider.example/privacy",
    };

    await validateProviderLegalReachability(
      "https://provider.example/registration.json",
      async (url) => {
        const path = new URL(url).pathname;
        if (path === "/registration.json") {
          return new Response(JSON.stringify(legal));
        }
        if (path === "/terms") return redirect.response;
        return new Response("ok");
      },
    );

    expect(redirect.wasCancelled()).toBe(true);
  });

  it("cancels bodies rejected by the declared content-length cap", async () => {
    const oversized = trackedResponse(200, { "content-length": "2048" });

    await expect(readBoundedBody(oversized.response, 1_024)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    expect(oversized.wasCancelled()).toBe(true);
  });
});
