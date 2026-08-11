import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { CdpFacilitatorClient } from "../src/bazaar/facilitatorClient.js";
import { parseBazaarExtensionResponse } from "../src/bazaar/extensionResponse.js";

const payload: PaymentPayload = {
  x402Version: 2,
  resource: { url: "https://gateway.test/x402/v1/outcomes/test" },
  accepted: requirements(),
  payload: {},
  extensions: {},
};
const signal = new AbortController().signal;

describe("strict CDP facilitator client", () => {
  it("pins the production origin and path", () => {
    expect(() => client(async () => json({ isValid: true, payer: payer() }), {
      baseUrl: "https://attacker.example/platform/v2/x402",
    })).toThrow(/pinned CDP endpoint/);
    expect(() => client(async () => json({ isValid: true, payer: payer() }), {
      baseUrl: "https://api.cdp.coinbase.com/other",
    })).toThrow(/pinned CDP endpoint/);
    expect(() => client(async () => json({ isValid: true, payer: payer() }), {
      allowInsecureTestUrl: true,
      baseUrl: "http://attacker.example/x402",
    })).toThrow(/loopback-only/);
    expect(() => client(async () => json({ isValid: true, payer: payer() }), {
      timeoutMs: 60_001,
    })).toThrow(/timeout is invalid/);
  });

  it("allows only bounded CDP authentication headers", async () => {
    const fetchFn = async () => json({ isValid: true, payer: payer() });
    const unsafe = new CdpFacilitatorClient({
      allowInsecureTestUrl: true,
      baseUrl: "http://127.0.0.1/x402",
      createAuthHeaders: async () => ({
        Authorization: "Bearer a.b.c",
        Host: "attacker.example",
      }),
      fetchFn: fetchFn as typeof fetch,
    });
    await expect(unsafe.verify(payload, requirements(), signal)).rejects.toThrow(/unsafe header/);

    let received: Headers | undefined;
    const safe = new CdpFacilitatorClient({
      allowInsecureTestUrl: true,
      baseUrl: "http://127.0.0.1/x402",
      createAuthHeaders: async () => ({
        Authorization: "Bearer a.b.c",
        "Correlation-Context": "sdkLanguage=typescript,source=cdp-sdk",
      }),
      fetchFn: (async (_url, init) => {
        received = new Headers(init?.headers);
        return json({ isValid: true, payer: payer() });
      }) as typeof fetch,
    });
    await safe.verify(payload, requirements(), signal);
    expect(received?.get("content-type")).toBe("application/json");
    expect(received?.get("authorization")).toBe("Bearer a.b.c");
  });

  it("treats server errors and authentication timeouts as ambiguous", async () => {
    let calls = 0;
    const serverError = client(async () => {
      calls += 1;
      return json({ error: "unavailable" }, 503);
    });
    await expect(serverError.verify(payload, requirements(), signal)).rejects.toThrow(/returned 503/);
    expect(calls).toBe(1);

    const authTimeout = new CdpFacilitatorClient({
      allowInsecureTestUrl: true,
      baseUrl: "http://127.0.0.1/x402",
      timeoutMs: 5,
      createAuthHeaders: () => new Promise(() => undefined),
      fetchFn: (async () => json({ isValid: true, payer: payer() })) as typeof fetch,
    });
    await expect(authTimeout.verify(payload, requirements(), signal)).rejects.toThrow(/timed out/);
  });

  it("aborts facilitator transport when its fenced owner loses the lease", async () => {
    const controller = new AbortController();
    const transport: { signal: AbortSignal | null } = { signal: null };
    let transportStarted!: () => void;
    const started = new Promise<void>((resolve) => { transportStarted = resolve; });
    const abortable = client((_unused, init) => {
      transport.signal = init?.signal as AbortSignal;
      transportStarted();
      return new Promise<Response>((_resolve, reject) => {
        transport.signal!.addEventListener("abort", () => {
          reject(transport.signal!.reason ?? new Error("aborted"));
        }, { once: true });
      });
    });
    const pending = abortable.verify(payload, requirements(), controller.signal);
    await started;
    controller.abort(new Error("lease lost"));
    await expect(pending).rejects.toThrow(/lease lost/);
    expect(transport.signal?.aborted).toBe(true);
  });

  it("rejects non-JSON, oversized, unknown, and contradictory responses", async () => {
    await expect(client(async () => new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })).verify(payload, requirements(), signal)).rejects.toThrow(/not JSON/);

    await expect(client(async () => json({
      isValid: true,
      payer: payer(),
      unknown: true,
    })).verify(payload, requirements(), signal)).rejects.toThrow(/unknown field/);

    await expect(client(async () => new Response(
      `{"isValid":false,"isValid":true,"payer":"${payer()}"}`,
      { status: 200, headers: { "content-type": "application/json" } },
    )).verify(payload, requirements(), signal)).rejects.toThrow(/duplicate JSON keys/);

    await expect(client(async () => json({
      isValid: true,
      payer: payer(),
    }, 400)).verify(payload, requirements(), signal)).rejects.toThrow(/contradictory/);

    await expect(client(async () => new Response(JSON.stringify({
      isValid: false,
      invalidReason: "x".repeat(70 * 1024),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })).verify(payload, requirements(), signal)).rejects.toThrow(/size limit/);

    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.enqueue(new Uint8Array(40 * 1024));
      },
      cancel() {
        canceled = true;
      },
    });
    await expect(client(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    })).verify(payload, requirements(), signal)).rejects.toThrow(/size limit/);
    expect(canceled).toBe(true);
  });

  it("strictly extracts Bazaar indexing diagnostics from EXTENSION-RESPONSES", () => {
    const header = Buffer.from(JSON.stringify({
      bazaar: { status: "rejected", rejectedReason: "schema mismatch" },
    }), "utf8").toString("base64");
    expect(parseBazaarExtensionResponse(header)).toMatchObject({
      status: "rejected",
    });
    expect(parseBazaarExtensionResponse("not base64")).toMatchObject({
      status: null,
      rejectedReasonHash: null,
    });
    const duplicate = Buffer.from(
      '{"bazaar":{"status":"rejected","status":"success"}}',
      "utf8",
    ).toString("base64");
    expect(parseBazaarExtensionResponse(duplicate)).toMatchObject({
      status: null,
      rejectedReasonHash: null,
    });
  });
});

function client(
  fetchFn: typeof fetch | (() => Promise<Response>),
  overrides: Partial<ConstructorParameters<typeof CdpFacilitatorClient>[0]> = {},
) {
  return new CdpFacilitatorClient({
    createAuthHeaders: async () => ({ Authorization: "Bearer a.b.c" }),
    fetchFn: fetchFn as typeof fetch,
    ...overrides,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    amount: "10000",
    payTo: "0x0000000000000000000000000000000000000001",
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  };
}

function payer(): string {
  return "0x0000000000000000000000000000000000000002";
}
