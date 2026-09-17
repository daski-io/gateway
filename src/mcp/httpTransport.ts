/** Compatibility route lifecycle; the live MCP transport is website-owned. */
export interface McpWiring { close(): Promise<void>; }
