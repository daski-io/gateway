import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { createStandardRailMcp } from "../../src/standardRail/mcp.js";
import { createStandardMetaRouter } from "../../src/standardRail/meta.js";

// Exercise the real HTTP tools/list handler. No tool callback, database,
// signer or remote service is invoked when listing the registered schemas.
export async function mcpSurfaceFixture() {
  const app = express();
  app.use(express.json());
  const config = {
    publicUrl: "http://127.0.0.1", mcpPath: "/mcp", chainId: 84532,
    marketplaceContracts: { reputationStorage: "0x" + "1".repeat(40) },
  } as never;
  const wiring = await createStandardRailMcp(app, config, {} as never, {} as never);
  app.use(createStandardMetaRouter({
    config, service: {} as never, pool: {} as never, lifecycle: {} as never,
    railConfig: {} as never,
  }));
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve); listener.once("error", reject);
  });
  const root = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  try {
    const response = await fetch(root + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const data = raw.startsWith("event:") || raw.startsWith("data:")
      ? raw.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("")
      : raw;
    const listed = JSON.parse(data) as { result: { tools: Array<Record<string, unknown> & { name: string }> } };
    const tools = listed.result.tools.map(({ name, inputSchema, outputSchema, annotations }) =>
      ({ name, inputSchema, outputSchema, annotations })).sort((a, b) => a.name.localeCompare(b.name));
    const metadata = await (await fetch(root + "/.well-known/mcp.json")).json() as { tools: string[] };
    assert.deepEqual([...metadata.tools].sort(), tools.map(tool => tool.name).sort(),
      "discovery metadata must agree with the runtime MCP tool catalog");
    return { schemaVersion: 1, tools };
  } finally {
    await wiring.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
}
