// The deployed build identifies itself by the commit Railway injects at build
// time (RAILWAY_GIT_COMMIT_SHA); nothing in this file is edited for a release.
// The release tag is the version of record; GATEWAY_VERSION is a display
// string for clients (mcp.json, MCP serverInfo, /health) and may be pinned
// with the GATEWAY_VERSION variable.
const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GATEWAY_COMMIT ?? "";
export const GATEWAY_COMMIT: string | null = /^[0-9a-f]{7,40}$/i.test(commitSha)
  ? commitSha.slice(0, 12).toLowerCase()
  : null;
export const GATEWAY_VERSION: string =
  process.env.GATEWAY_VERSION ?? (GATEWAY_COMMIT ? `git-${GATEWAY_COMMIT}` : "dev");
