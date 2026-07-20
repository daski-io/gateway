import {
  readBoundedJson,
  safeFetch,
  validateUrlForOutbound,
  type ValidatedUrl,
} from "../util/urlSafety.js";

const AGENT_CARD_MAX_BYTES = 256 * 1024;

export type AgentCardFetchFn = (
  url: string,
  init?: RequestInit,
  preValidated?: ValidatedUrl,
) => Promise<Response>;

interface AgentCardFetcherOptions {
  fetch?: AgentCardFetchFn;
  timeoutMs?: number;
}

export class AgentCardFetcher {
  private readonly fetchFn: AgentCardFetchFn;
  private readonly timeoutMs: number;

  constructor(options: AgentCardFetcherOptions = {}) {
    this.fetchFn = options.fetch ?? safeFetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async fetchJson(uri: string, deadlineAt: number): Promise<Record<string, unknown>> {
    const validated =
      this.fetchFn === safeFetch ? await validateUrlForOutbound(uri) : undefined;
    const first = await this.fetchOnce(uri, deadlineAt, validated);
    try {
      if (first.response.status >= 300 && first.response.status < 400) {
        const location = first.response.headers.get("location");
        if (location) {
          const next = new URL(location, uri).toString();
          const nextValidated =
            this.fetchFn === safeFetch
              ? await validateUrlForOutbound(next)
              : undefined;
          first.finish();
          const followed = await this.fetchOnce(next, deadlineAt, nextValidated);
          try {
            return await this.readJson(followed.response);
          } finally {
            followed.finish();
          }
        }
      }
      return await this.readJson(first.response);
    } finally {
      first.finish();
    }
  }

  private async fetchOnce(
    uri: string,
    deadlineAt: number,
    validated: ValidatedUrl | undefined,
  ): Promise<{ response: Response; finish(): void }> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error("discovery refresh deadline exceeded");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(this.timeoutMs, remainingMs),
    );
    try {
      const response = await this.fetchFn(
        uri,
        { signal: controller.signal, redirect: "manual" },
        validated,
      );
      return { response, finish: () => clearTimeout(timer) };
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await readBoundedJson<Record<string, unknown>>(
      response,
      AGENT_CARD_MAX_BYTES,
    );
    if (typeof json !== "object" || json === null) {
      throw new Error("Agent card is not an object");
    }
    return json;
  }
}
