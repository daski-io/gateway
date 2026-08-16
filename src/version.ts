// Bump on EVERY release, point releases included — this string is the only
// runtime version signal (mcp.json, /health/live, /health/ready, MCP
// serverInfo). v0.8.1–v0.8.3 shipped without bumping it, so deployed point
// releases were indistinguishable from 0.8.0 at runtime.
export const GATEWAY_VERSION = "0.20.1";
