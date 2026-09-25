import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import {
  clientAddress,
  decideEdge,
  installEdgeBoundary,
  isPrivatePeer,
  normalizeAddress,
} from "../src/http/edgeBoundary.js";

const secret = Buffer.from("s".repeat(64));
const publicRequest = {
  path: "/wallet/orders",
  peer: "100.64.0.7",
  secretHeader: undefined,
  connectingIp: undefined,
  forwardedFor: "1.2.3.4",
};

describe("edge boundary", () => {
  it("classifies Railway's private network and local peers, never the public edge", () => {
    expect(isPrivatePeer("fd12:2517:318f::a")).toBe(true);
    expect(isPrivatePeer("::ffff:10.1.2.3")).toBe(true);
    expect(isPrivatePeer("172.31.0.1")).toBe(true);
    expect(isPrivatePeer("127.0.0.1")).toBe(true);
    expect(isPrivatePeer("::1")).toBe(true);
    expect(isPrivatePeer("100.64.0.7")).toBe(false);
    expect(isPrivatePeer("172.67.145.24")).toBe(false);
    expect(isPrivatePeer("2606:4700::1")).toBe(false);
    expect(isPrivatePeer("not-an-address")).toBe(false);
    expect(normalizeAddress("[::ffff:203.0.113.9]")).toBe("203.0.113.9");
    expect(normalizeAddress("fe80::1%eth0")).toBe("fe80::1");
  });

  it("refuses a public request without the edge secret and never believes its forwarded addresses", () => {
    expect(decideEdge(publicRequest, secret)).toMatchObject({ admit: false, status: 403, code: "EDGE_REQUIRED" });
    expect(decideEdge({ ...publicRequest, secretHeader: "s".repeat(63) + "x" }, secret))
      .toMatchObject({ admit: false, status: 403, code: "EDGE_REQUIRED" });
    expect(decideEdge({ ...publicRequest, secretHeader: "s".repeat(64) }, secret))
      .toMatchObject({ admit: false, status: 400, code: "EDGE_CLIENT_ADDRESS_MISSING" });
    expect(decideEdge({ ...publicRequest, secretHeader: "s".repeat(64), connectingIp: "203.0.113.9" }, secret))
      .toEqual({ admit: true, clientAddress: "203.0.113.9" });
  });

  it("trusts the website's one private-network hop and lets health through untouched", () => {
    expect(decideEdge({ ...publicRequest, peer: "fd12:2517:318f::a", forwardedFor: "198.51.100.4" }, secret))
      .toEqual({ admit: true, clientAddress: "198.51.100.4" });
    expect(decideEdge({ ...publicRequest, peer: "fd12:2517:318f::a", forwardedFor: undefined }, secret))
      .toEqual({ admit: true, clientAddress: "fd12:2517:318f::a" });
    expect(decideEdge({ ...publicRequest, path: "/health/ready" }, secret))
      .toEqual({ admit: true, clientAddress: "100.64.0.7" });
  });

  it("without a configured edge the socket peer is the client", () => {
    expect(decideEdge(publicRequest, null)).toEqual({ admit: true, clientAddress: "100.64.0.7" });
  });

  it("installs ahead of the routes and names the client for them", async () => {
    const app = express();
    installEdgeBoundary(app, { edgeSecret: "s".repeat(64) });
    app.get("/echo", (req, res) => { res.json({ client: clientAddress(req) }); });
    const server: Server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/echo`;
    try {
      // Loopback is a private peer: its forwarded address is the client and no secret is needed.
      const forwarded = await fetch(url, { headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.1" } });
      await expect(forwarded.json()).resolves.toEqual({ client: "198.51.100.4" });
      const plain = await fetch(url);
      await expect(plain.json()).resolves.toEqual({ client: "127.0.0.1" });
      expect(app.get("trust proxy")).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
