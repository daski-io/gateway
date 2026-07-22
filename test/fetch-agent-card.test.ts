import { describe, expect, it } from "vitest";
import {
  AgentCardFetchError,
  fetchAgentCard,
} from "../src/identity/fetch-agent-card.js";

describe("buyer Agent Card fetching", () => {
  it("keeps the timeout active while reading the response body", async () => {
    const fetchFn = async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return new Response(
        new ReadableStream<Uint8Array>({
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
        }),
        { status: 200 },
      );
    };

    await expect(
      fetchAgentCard("https://buyer.test/card.json", {
        ipfsGatewayUrl: "https://ipfs.io/ipfs/",
        fetchFn,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      code: "AGENT_URI_TIMEOUT",
    } satisfies Partial<AgentCardFetchError>);
  });
});
