import { once } from "node:events";
import express from "express";
import { it, expect, vi } from "vitest";
import { configureMiddleware } from "../src/http/middleware.js";

it("keeps health and authenticated fences available after anonymous fence ingress is exhausted", async () => {
  const app=express();
  const counts=new Map<string,number>();
  const consumeRateLimitBucket=vi.fn(async(key:string)=>{
    const count=(counts.get(key)??0)+1; counts.set(key,count);
    return {count,resetAt:new Date(Date.now()+60_000)};
  });
  configureMiddleware(app,{consumeRateLimitBucket},{
    nodeEnv:"production",catalogOperatorToken:"fixture-operator",publicReadMaxPerMinute:2,publicReadGlobalMaxPerMinute:10,
    stateChangeGlobalMaxPerMinute:100,paymentResourcePerClientPerMinute:30,rpcReadMaxPerMinute:100,dynamicServiceRegistrationEnabled:false,
  } as never,{abuse:{walletChallengesPerClientPerMinute:30,walletChallengesGlobalPerMinute:100}} as never);
  const fence=vi.fn((_req,res)=>res.json({ok:true}));
  app.get("/health/live",(_req,res)=>res.json({ok:true}));
  app.post("/internal/release/v1/registration-fences",fence);
  app.get("/internal/release/v1/capabilities",(_req,res)=>res.json({ok:true}));
  app.get("/internal/release/v1/registration-fences",(_req,res)=>res.json({ok:true}));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const url="http://127.0.0.1:"+(server.address() as {port:number}).port;
  try {
    for(let i=0;i<130;i++) expect((await fetch(url+"/health/live")).status).toBe(200);
    expect(consumeRateLimitBucket).not.toHaveBeenCalled();
    for(let i=0;i<30;i++)expect((await fetch(url+"/internal/release/v1/registration-fences",{method:"POST"})).status).toBe(200);
    expect((await fetch(url+"/internal/release/v1/registration-fences",{method:"POST"})).status).toBe(429);
    expect(fence).toHaveBeenCalledTimes(30);
    expect(consumeRateLimitBucket).toHaveBeenCalledTimes(30);
    expect((await fetch(url+"/internal/release/v1/registration-fences",{method:"POST",headers:{authorization:"Bearer fixture-operator"}})).status).toBe(200);
    expect(fence).toHaveBeenCalledTimes(31);
    expect([...counts.keys()].every(key=>key.startsWith("release-fence:"))).toBe(true);
    for(let i=0;i<40;i++) {
      expect((await fetch(url+"/internal/release/v1/capabilities")).status).toBe(200);
      expect((await fetch(url+"/internal/release/v1/registration-fences")).status).toBe(200);
    }
    expect(consumeRateLimitBucket).toHaveBeenCalledTimes(30);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
