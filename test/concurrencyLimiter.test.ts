import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../src/mcp/concurrencyLimiter.js";

describe("ConcurrencyLimiter", () => {
  it("enforces global and per-key limits and releases idempotently", () => {
    const limiter = new ConcurrencyLimiter(2, 1);
    const releaseA = limiter.tryAcquire("a");
    const releaseB = limiter.tryAcquire("b");

    expect(releaseA).not.toBeNull();
    expect(releaseB).not.toBeNull();
    expect(limiter.tryAcquire("a")).toBeNull();
    expect(limiter.tryAcquire("c")).toBeNull();

    releaseA?.();
    releaseA?.();
    const releaseC = limiter.tryAcquire("c");
    expect(releaseC).not.toBeNull();

    releaseB?.();
    releaseC?.();
  });
});
