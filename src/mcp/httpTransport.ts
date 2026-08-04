import type { Express, Request, Response } from "express";
import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/express";
import {
  createMcpHandler,
  type McpRequestContext,
  type McpServer,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { logErrorWithId } from "../util/errorWrap.js";
import { withRequestDisconnectSignal } from "./requestContext.js";

export interface McpWiring {
  close(): Promise<void>;
}

export interface McpHttpTransportOptions {
  app: Express;
  path: string;
  createServer(context: McpRequestContext): McpServer;
  allowedHosts: string[];
  allowedOrigins: string[];
}

function rejectBatchRequest(req: Request, res: Response): boolean {
  if (!Array.isArray(req.body)) return false;
  res.status(400).json({
    jsonrpc: "2.0",
    error: {
      code: -32600,
      message: "JSON-RPC batch requests are not supported",
    },
    id: null,
  });
  return true;
}

export function mountMcpHttpTransport(
  options: McpHttpTransportOptions,
): McpWiring {
  const handler = createMcpHandler(options.createServer, {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => {
      logErrorWithId("mcp.protocol", error);
    },
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => {
      logErrorWithId("mcp.httpAdapter", error);
    },
  });
  const validateHost = hostHeaderValidation(options.allowedHosts);
  const validateOrigin = originValidation(options.allowedOrigins);

  options.app.all(
    options.path,
    validateHost,
    validateOrigin,
    async (req, res) => {
      if (rejectBatchRequest(req, res)) return;
      await withRequestDisconnectSignal(req, res, () =>
        nodeHandler(req, res, req.body),
      );
    },
  );

  return {
    close: handler.close,
  };
}
