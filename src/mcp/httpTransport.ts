import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { logErrorWithId } from "../util/errorWrap.js";

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
  clientKey: string;
}

export interface McpWiring {
  sessionCount(): number;
  close(): Promise<void>;
}

export interface McpHttpTransportOptions {
  app: Express;
  path: string;
  createServer(): McpServer;
  maxSessions?: number;
  maxSessionsPerClient?: number;
  idleTtlMs?: number;
  sweepIntervalMs?: number;
  allowedOrigins?: string[];
}

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_SESSIONS_PER_CLIENT = 10;
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

function sessionId(req: Request): string | undefined {
  const raw = req.headers["mcp-session-id"];
  return Array.isArray(raw) ? raw[0] : raw;
}

function unknownSession(res: Response): void {
  res.status(404).json({
    jsonrpc: "2.0",
    error: { code: -32600, message: "Unknown MCP session" },
    id: null,
  });
}

function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function mountMcpHttpTransport(
  options: McpHttpTransportOptions,
): McpWiring {
  const sessions = new Map<string, Session>();
  const closing = new Set<string>();
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxSessionsPerClient =
    options.maxSessionsPerClient ??
    Math.min(DEFAULT_MAX_SESSIONS_PER_CLIENT, maxSessions);
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const sweepIntervalMs =
    options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  if (
    !Number.isInteger(maxSessions) ||
    maxSessions <= 0 ||
    !Number.isInteger(maxSessionsPerClient) ||
    maxSessionsPerClient <= 0 ||
    maxSessionsPerClient > maxSessions ||
    !Number.isFinite(idleTtlMs) ||
    idleTtlMs <= 0 ||
    !Number.isFinite(sweepIntervalMs) ||
    sweepIntervalMs <= 0
  ) {
    throw new Error("MCP session limits and timeouts must be positive");
  }
  let pendingInitializations = 0;
  const pendingByClient = new Map<string, number>();

  function originAllowed(req: Request): boolean {
    const origin = req.header("origin");
    if (!origin) return true;
    return (options.allowedOrigins ?? []).includes(origin);
  }

  function rejectDisallowedOrigin(req: Request, res: Response): boolean {
    if (originAllowed(req)) return false;
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Origin is not allowed" },
      id: null,
    });
    return true;
  }

  async function closeSession(id: string, session: Session): Promise<void> {
    if (closing.has(id)) return;
    closing.add(id);
    sessions.delete(id);
    try {
      await session.transport.close();
    } catch {
      // The peer may already have dropped the transport.
    }
    try {
      await session.server.close();
    } catch {
      // Server teardown is best-effort after transport closure.
    }
    closing.delete(id);
  }

  async function removeExpired(now = Date.now()): Promise<void> {
    const expired = [...sessions.entries()].filter(
      ([, session]) => now - session.lastSeenAt >= idleTtlMs,
    );
    await Promise.all(expired.map(([id, session]) => closeSession(id, session)));
  }

  const sweep = setInterval(() => {
    void removeExpired().catch((err) => {
      logErrorWithId("mcp.sessionSweep", err);
    });
  }, sweepIntervalMs);
  sweep.unref?.();

  function buildSession(ownerKey: string): {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
  } {
    const server = options.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, {
          server,
          transport,
          lastSeenAt: Date.now(),
          clientKey: ownerKey,
        });
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        const session = sessions.get(id);
        sessions.delete(id);
        if (session && !closing.has(id)) {
          void session.server.close().catch((err) => {
            logErrorWithId("mcp.sessionClose", err);
          });
        }
      }
    };
    return { server, transport };
  }

  options.app.post(options.path, async (req, res) => {
    try {
      if (rejectDisallowedOrigin(req, res)) return;
      const id = sessionId(req);
      const existing = id ? sessions.get(id) : undefined;
      if (existing) {
        existing.lastSeenAt = Date.now();
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!id && isInitializeRequest(req.body)) {
        await removeExpired();
        const ownerKey = clientKey(req);
        if (sessions.size + pendingInitializations >= maxSessions) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "MCP session capacity reached; retry later",
            },
            id:
              (req.body as { id?: unknown } | undefined)?.id ?? null,
          });
          return;
        }
        const activeForClient = [...sessions.values()].filter(
          (session) => session.clientKey === ownerKey,
        ).length;
        const pendingForClient = pendingByClient.get(ownerKey) ?? 0;
        if (activeForClient + pendingForClient >= maxSessionsPerClient) {
          res.status(429).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "MCP session limit reached for this client",
            },
            id: (req.body as { id?: unknown } | undefined)?.id ?? null,
          });
          return;
        }
        pendingInitializations += 1;
        pendingByClient.set(ownerKey, pendingForClient + 1);
        let fresh:
          | {
              server: McpServer;
              transport: StreamableHTTPServerTransport;
            }
          | undefined;
        try {
          fresh = buildSession(ownerKey);
          await fresh.server.connect(fresh.transport);
          await fresh.transport.handleRequest(req, res, req.body);
        } finally {
          pendingInitializations -= 1;
          const remaining = (pendingByClient.get(ownerKey) ?? 1) - 1;
          if (remaining > 0) pendingByClient.set(ownerKey, remaining);
          else pendingByClient.delete(ownerKey);
          if (fresh && !fresh.transport.sessionId) {
            await fresh.transport.close().catch(() => undefined);
            await fresh.server.close().catch(() => undefined);
          }
        }
        return;
      }
      unknownSession(res);
    } catch (err) {
      logErrorWithId("mcp.post", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  async function handleExisting(req: Request, res: Response): Promise<void> {
    if (rejectDisallowedOrigin(req, res)) return;
    const id = sessionId(req);
    const existing = id ? sessions.get(id) : undefined;
    if (!existing) {
      unknownSession(res);
      return;
    }
    existing.lastSeenAt = Date.now();
    try {
      await existing.transport.handleRequest(req, res);
    } catch (err) {
      logErrorWithId(`mcp.${req.method.toLowerCase()}`, err);
      if (!res.headersSent) res.status(500).end();
    }
  }

  options.app.get(options.path, handleExisting);
  options.app.delete(options.path, handleExisting);

  return {
    sessionCount: () => sessions.size,
    async close() {
      clearInterval(sweep);
      await Promise.all(
        [...sessions.entries()].map(([id, session]) =>
          closeSession(id, session),
        ),
      );
    },
  };
}
