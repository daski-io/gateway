import express from "express";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  McpServer,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import {
  mountMcpHttpTransport,
  type McpWiring,
} from "../src/mcp/httpTransport.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startTransport(options: {
  allowedHosts?: string[];
  allowedOrigins?: string[];
  createServer?: (context: McpRequestContext) => McpServer;
} = {}) {
  const app = express();
  app.use(express.json());
  const wiring: McpWiring = mountMcpHttpTransport({
    app,
    path: "/mcp",
    createServer:
      options.createServer ??
      (() => new McpServer({ name: "transport-test", version: "1.0.0" })),
    allowedHosts: options.allowedHosts ?? ["127.0.0.1"],
    allowedOrigins: options.allowedOrigins ?? ["127.0.0.1"],
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  cleanups.push(async () => {
    await wiring.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { wiring, url };
}

describe("stateless MCP HTTP transport", () => {
  it("serves the 2026 protocol through server/discover", async () => {
    const eras: string[] = [];
    const { url } = await startTransport({
      createServer: (context) => {
        eras.push(context.era);
        return new McpServer(
          { name: "modern-test", version: "1.0.0" },
          {
            instructions: "modern instructions",
            cacheHints: {
              "server/discover": { ttlMs: 60_000, cacheScope: "public" },
            },
          },
        );
      },
    });
    const transport = new ModernTransport(url);
    const client = new ModernClient(
      { name: "modern-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    cleanups.push(() => client.close());

    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect(client.getInstructions()).toBe("modern instructions");
    expect(client.getDiscoverResult()).toMatchObject({
      ttlMs: 60_000,
      cacheScope: "public",
    });
    expect(eras).toContain("modern");
  });

  it("keeps old clients working through the SDK stateless fallback", async () => {
    let factories = 0;
    const { url } = await startTransport({
      createServer: () => {
        factories += 1;
        const server = new McpServer({ name: "legacy-test", version: "1.0.0" });
        server.registerTool("echo", { inputSchema: {} }, async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }));
        return server;
      },
    });
    const transport = new LegacyTransport(url);
    const client = new LegacyClient({ name: "legacy-client", version: "1.0.0" });
    await client.connect(transport);
    cleanups.push(() => client.close());

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "echo",
    );
    expect(transport.sessionId).toBeUndefined();
    expect(factories).toBeGreaterThan(1);
  });

  it("rejects browser requests from origins outside the allowlist", async () => {
    const { url } = await startTransport({
      allowedOrigins: ["gateway.example"],
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "origin-test", version: "1.0.0" },
        },
      }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects a Host header outside the public gateway hostname", async () => {
    const { url } = await startTransport();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "attacker.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "host-test", version: "1.0.0" },
        },
      }),
    });
    expect(response.status).toBe(406);
  });

  it("rejects JSON-RPC batches before dispatching any tool call", async () => {
    const calls = vi.fn();
    const { url } = await startTransport({
      createServer: () => {
        const server = new McpServer({ name: "batch-test", version: "1.0.0" });
        server.registerTool("mutate", { inputSchema: {} }, async () => {
          calls();
          return { content: [{ type: "text" as const, text: "ok" }] };
        });
        return server;
      },
    });
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "mutate", arguments: {} },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "mutate", arguments: {} },
        },
      ]),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: -32600,
        message: "JSON-RPC batch requests are not supported",
      },
    });
    expect(calls).not.toHaveBeenCalled();
  });

  it("does not expose legacy GET or DELETE session lifecycle routes", async () => {
    const { url } = await startTransport();
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
  });
});
