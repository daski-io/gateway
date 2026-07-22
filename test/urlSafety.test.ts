import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  safeFetch,
  UrlSafetyError,
  validateUrlForOutbound,
  type ValidatedUrl,
} from "../src/util/urlSafety.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("outbound URL safety", () => {
  it.each([
    "http://127.0.0.1/resource",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/resource",
    "http://[::ffff:7f00:1]/resource",
    "http://240.0.0.1/resource",
    "http://example.com/resource",
    "https://user:password@example.com/resource",
    "ftp://example.com/resource",
  ])("rejects blocked target %s even under NODE_ENV=test", async (url) => {
    await expect(validateUrlForOutbound(url)).rejects.toBeInstanceOf(
      UrlSafetyError,
    );
  });

  it("connects to the validated IP while preserving the original Host", async () => {
    let receivedHost = "";
    const server = http.createServer((req, res) => {
      receivedHost = req.headers.host ?? "";
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a TCP port");
    }
    const url = new URL(`http://provider.test:${address.port}/agent.json`);
    const validated: ValidatedUrl = {
      url,
      resolvedAddrs: ["127.0.0.1"],
    };
    const response = await safeFetch(url.href, undefined, validated);
    expect(await response.json()).toEqual({ ok: true });
    expect(receivedHost).toBe(`provider.test:${address.port}`);
  });

  it("does not reuse a validation handle for a different URL", async () => {
    const validated: ValidatedUrl = {
      url: new URL("https://example.com/card"),
      resolvedAddrs: ["93.184.216.34"],
    };
    await expect(
      safeFetch("https://127.0.0.1/private", undefined, validated),
    ).rejects.toMatchObject({ code: "URL_PRIVATE_HOST" });
  });
});
