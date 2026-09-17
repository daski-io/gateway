import type { Express } from "express";
import type { Config } from "../config.js";
import type { McpWiring } from "../mcp/httpTransport.js";

/** The MCP server is website-owned. Preserve the old client URL during migration. */
export async function createStandardRailMcp(app: Express, config: Config): Promise<McpWiring> {
  app.all(config.mcpPath, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.redirect(307, `${config.docsUrl}/mcp`);
  });
  return { close: async () => {} };
}
