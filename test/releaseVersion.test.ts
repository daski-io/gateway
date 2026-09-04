import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it("image source identity overrides Railway metadata and preserves the short display commit", async () => {
  vi.stubEnv("RELEASE_SOURCE_SHA", "a".repeat(40));
  vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "b".repeat(40));
  const version = await import("../src/version.js");
  expect(version.GATEWAY_SOURCE_SHA).toBe("a".repeat(40));
  expect(version.GATEWAY_COMMIT).toBe("a".repeat(12));
});
it("source-main builds retain Railway commit identity when no image source is injected", async () => {
  vi.stubEnv("RELEASE_SOURCE_SHA", "");
  vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "b".repeat(40));
  const version = await import("../src/version.js");
  expect(version.GATEWAY_SOURCE_SHA).toBe("b".repeat(40));
  expect(version.GATEWAY_COMMIT).toBe("b".repeat(12));
});
