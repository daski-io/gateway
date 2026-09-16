import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { createStandardRailMcp } from "../../src/standardRail/mcp.js";
import { createStandardMetaRouter } from "../../src/standardRail/meta.js";

// Verify the legacy redirect and gateway discovery against the retained MCP
// contract. The website tests its actual tools/list against the same fixture.
export async function mcpSurfaceFixture() {
  const app = express();
  app.use(express.json());
  const config = {
    publicUrl: "http://127.0.0.1", docsUrl: "https://website.example", mcpPath: "/mcp", chainId: 84532,
    marketplaceContracts: { reputationStorage: "0x" + "1".repeat(40) },
  } as never;
  const wiring = await createStandardRailMcp(app, config);
  app.use(createStandardMetaRouter({
    config, service: {} as never, pool: {} as never, lifecycle: {} as never,
    railConfig: { payerAccountTypes: ["eoa"] } as never,
  }));
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve); listener.once("error", reject);
  });
  const root = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  try {
    const response = await fetch(root + "/mcp", { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "https://website.example/mcp");
    // The website tests its live tools/list against this unchanged contract.
    const fixture = JSON.parse(readFileSync(new URL("../wire-fixtures/mcp-tool-surface.json", import.meta.url), "utf8"));
    const tools = fixture.tools as Array<{ name: string }>;
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
