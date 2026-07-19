import express from "express";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  mountMcpHttpTransport,
  type McpWiring,
} from "../src/mcp/httpTransport.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startTransport(options: {
  maxSessions?: number;
  idleTtlMs?: number;
  sweepIntervalMs?: number;
}) {
  const app = express();
  app.use(express.json());
  const wiring: McpWiring = mountMcpHttpTransport({
    app,
    path: "/mcp",
    createServer: () =>
      new McpServer({ name: "transport-test", version: "1.0.0" }),
    ...options,
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

async function connect(url: URL) {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "transport-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("MCP HTTP session lifecycle", () => {
  it("rejects initialization after the bounded capacity is reached", async () => {
    const { wiring, url } = await startTransport({ maxSessions: 1 });
    const first = await connect(url);
    await expect(connect(url)).rejects.toThrow(/503|capacity/i);
    expect(wiring.sessionCount()).toBe(1);
    await first.transport.close();
  });

  it("closes idle sessions during the sweep", async () => {
    const { wiring, url } = await startTransport({
      maxSessions: 2,
      idleTtlMs: 20,
      sweepIntervalMs: 10,
    });
    await connect(url);
    expect(wiring.sessionCount()).toBe(1);
    await vi.waitFor(() => expect(wiring.sessionCount()).toBe(0), {
      timeout: 1000,
      interval: 10,
    });
  });
});
