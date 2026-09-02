import { describe, expect, it } from "vitest";
import { discardResponseBody, readBoundedJsonResponse } from "../src/standardRail/boundedJson.js";
import { boundedBucketKey } from "../src/util/security.js";

function neverEndingBody(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([0x7b]));
    },
    cancel() {
      onCancel();
    },
  });
}

describe("abandoned provider responses", () => {
  it("cancels the body when the media type is refused before reading", async () => {
    let cancelled = false;
    const response = new Response(neverEndingBody(() => { cancelled = true; }), {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    await expect(readBoundedJsonResponse(response, 1_024)).rejects.toThrow("BOUNDED_JSON_MEDIA_TYPE_INVALID");
    expect(cancelled).toBe(true);
  });

  it("cancels the body when the declared length is refused before reading", async () => {
    let cancelled = false;
    const response = new Response(neverEndingBody(() => { cancelled = true; }), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "99999" },
    });
    await expect(readBoundedJsonResponse(response, 1_024)).rejects.toThrow("BOUNDED_JSON_TOO_LARGE");
    expect(cancelled).toBe(true);
  });

  it("discards explicitly and tolerates bodies that are absent or already closed", async () => {
    let cancelled = false;
    await discardResponseBody(new Response(neverEndingBody(() => { cancelled = true; }), { status: 503 }));
    expect(cancelled).toBe(true);
    await expect(discardResponseBody(new Response(null, { status: 204 }))).resolves.toBeUndefined();
    const consumed = new Response("{}", { status: 200 });
    await consumed.text();
    await expect(discardResponseBody(consumed)).resolves.toBeUndefined();
  });
});

describe("rate-limit bucket keys", () => {
  it("keeps ordinary client addresses verbatim", () => {
    expect(boundedBucketKey("203.0.113.9")).toBe("203.0.113.9");
    expect(boundedBucketKey("::ffff:203.0.113.9")).toBe("::ffff:203.0.113.9");
    expect(boundedBucketKey("provider:8327")).toBe("provider:8327");
  });

  it("digests anything long or outside the address alphabet", () => {
    const forged = boundedBucketKey(`${"a".repeat(3_000)}, 10.0.0.1`);
    expect(forged).toMatch(/^h:[0-9a-f]{64}$/);
    expect(boundedBucketKey("bad key\n")).toMatch(/^h:[0-9a-f]{64}$/);
    expect(boundedBucketKey("x".repeat(129))).toMatch(/^h:[0-9a-f]{64}$/);
    expect(boundedBucketKey("x".repeat(128))).toBe("x".repeat(128));
  });
});
