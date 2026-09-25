import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Express, NextFunction, Request, Response } from "express";
import type { Config } from "../config.js";

// Who the client is, decided once per request before anything reads it.
//
// The gateway sits behind Cloudflare, which forwards to Railway's edge, which
// forwards to the container. Counting forwarding hops (the retired
// `TRUST_PROXY`) named a proxy as the client whenever the chain was longer
// than declared (2026-09-24: every caller shared one rate-limit bucket keyed
// by a CDN hop's address), and a higher count would have believed an address
// a direct caller wrote itself. So the chain is not counted. Cloudflare adds a
// secret header to every request it forwards; a public request without it is
// refused, and the client is the address Cloudflare names in CF-Connecting-IP,
// which it always sets itself. The website's MCP server reaches the gateway
// over Railway's private network and forwards the address of the MCP client
// it serves; that one hop is trusted. Health probes carry nothing and are
// answered from anywhere: the release coordinators read them on the Railway
// domain directly.

export const EDGE_SECRET_HEADER = "x-daski-edge-secret";
export const EDGE_CLIENT_HEADER = "cf-connecting-ip";

declare module "express-serve-static-core" {
  interface Request {
    /** The client address the edge boundary established for this request. */
    clientAddress?: string;
  }
}

export type EdgeDecision =
  | { admit: true; clientAddress: string }
  | { admit: false; status: number; code: string; message: string };

export interface EdgeRequest {
  path: string;
  peer: string | undefined;
  secretHeader: string | undefined;
  connectingIp: string | undefined;
  forwardedFor: string | undefined;
}

/** A bare address without brackets, zone or IPv4-mapped prefix, or "" when it is not one. */
export function normalizeAddress(value: string | undefined): string {
  let ip = (value ?? "").trim().replace(/^\[|\]$/g, "").split("%", 1)[0];
  if (ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : "";
}

// Railway's private network is IPv6 unique-local space (the sandbox website
// arrives from fd12::/16); RFC 1918 and loopback cover local runs. Railway's
// public edge reaches the container from carrier-grade NAT space
// (100.64.0.0/10), which is deliberately not private here.
export function isPrivatePeer(address: string): boolean {
  const ip = normalizeAddress(address);
  if (!ip) return false;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (ip === "::1") return true;
  const first = Number.parseInt(ip.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00;
}

const HEALTH_PATHS = new Set(["/health", "/health/live", "/health/ready"]);

export function decideEdge(request: EdgeRequest, secret: Buffer | null): EdgeDecision {
  const peer = normalizeAddress(request.peer) || "unknown";
  if (HEALTH_PATHS.has(request.path)) return { admit: true, clientAddress: peer };
  if (isPrivatePeer(peer)) {
    const forwarded = normalizeAddress(request.forwardedFor?.split(",")[0]);
    return { admit: true, clientAddress: forwarded || peer };
  }
  // No edge configured (a local run): the socket peer is all there is.
  if (!secret) return { admit: true, clientAddress: peer };
  const presented = Buffer.from(request.secretHeader ?? "");
  if (presented.length !== secret.length || !timingSafeEqual(presented, secret)) {
    return { admit: false, status: 403, code: "EDGE_REQUIRED", message: "Requests reach the gateway only through its edge." };
  }
  const client = normalizeAddress(request.connectingIp);
  if (!client) {
    return { admit: false, status: 400, code: "EDGE_CLIENT_ADDRESS_MISSING", message: "The edge did not name the client address." };
  }
  return { admit: true, clientAddress: client };
}

/** The client address for rate limits, challenge caps and admission keys. */
export function clientAddress(req: Pick<Request, "clientAddress" | "socket">): string {
  return req.clientAddress ?? (normalizeAddress(req.socket?.remoteAddress) || "unknown");
}

export function installEdgeBoundary(app: Express, config: Pick<Config, "edgeSecret">): void {
  // Forwarding chains are not counted; the boundary names the client.
  app.set("trust proxy", false);
  const secret = config.edgeSecret ? Buffer.from(config.edgeSecret) : null;
  app.use((req: Request, res: Response, next: NextFunction) => {
    const decision = decideEdge({
      path: req.path,
      peer: req.socket.remoteAddress,
      secretHeader: req.get(EDGE_SECRET_HEADER),
      connectingIp: req.get(EDGE_CLIENT_HEADER),
      forwardedFor: req.get("x-forwarded-for"),
    }, secret);
    if (!decision.admit) {
      res.status(decision.status).json({ error: { code: decision.code, message: decision.message } });
      return;
    }
    req.clientAddress = decision.clientAddress;
    next();
  });
}
