import { once } from "node:events";
import express from "express";
import { it, expect, vi } from "vitest";
import { configureMiddleware } from "../src/http/middleware.js";

it("sheds anonymous health traffic locally and limits signed fence requests before the handler", async () => {
  const app=express();
  const consumeRateLimitBucket=vi.fn(async()=>({count:1,resetAt:new Date(Date.now()+60_000)}));
  configureMiddleware(app,{consumeRateLimitBucket},{
    nodeEnv:"production",publicReadMaxPerMinute:2,publicReadGlobalMaxPerMinute:10,
    stateChangeGlobalMaxPerMinute:100,rpcReadMaxPerMinute:100,dynamicServiceRegistrationEnabled:false,
  } as never,{abuse:{walletChallengesPerClientPerMinute:30,walletChallengesGlobalPerMinute:100}} as never);
  const fence=vi.fn((_req,res)=>res.json({ok:true}));
  app.get("/health/live",(_req,res)=>res.json({ok:true}));
  app.post("/internal/release/v1/registration-fences",fence);
  app.get("/internal/release/v1/capabilities",(_req,res)=>res.json({ok:true}));
  app.get("/internal/release/v1/registration-fences",(_req,res)=>res.json({ok:true}));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const url="http://127.0.0.1:"+(server.address() as {port:number}).port;
  try {
    expect((await fetch(url+"/health/live")).status).toBe(200);
    expect((await fetch(url+"/health/live")).status).toBe(200);
    expect((await fetch(url+"/health/live")).status).toBe(429);
    expect(consumeRateLimitBucket).not.toHaveBeenCalled();
    for(let i=0;i<30;i++)expect((await fetch(url+"/internal/release/v1/registration-fences",{method:"POST"})).status).toBe(200);
    expect((await fetch(url+"/internal/release/v1/registration-fences",{method:"POST"})).status).toBe(429);
    expect(fence).toHaveBeenCalledTimes(30);
    expect(consumeRateLimitBucket).toHaveBeenCalledTimes(60);
    for(let i=0;i<40;i++) {
      expect((await fetch(url+"/internal/release/v1/capabilities")).status).toBe(200);
      expect((await fetch(url+"/internal/release/v1/registration-fences")).status).toBe(200);
    }
    expect(consumeRateLimitBucket).toHaveBeenCalledTimes(60);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
