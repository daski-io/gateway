import express from "express";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createStandardMetaRouter } from "../src/standardRail/meta.js";
import { RetirementBlocked, parseRetirementScope } from "../src/standardRail/releaseRetirements.js";
const scope={kind:"listing" as const,providerAgentId:"7",serviceId:"0x"+"04".repeat(32),listingManifestHash:"0x"+"03".repeat(32)};
let server:Server|undefined;
afterEach(async()=>{if(server) await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));server=undefined;});
async function start(retire: unknown,state:unknown) {
  const app=express();app.use(express.json());
  app.use(createStandardMetaRouter({config:{catalogOperatorToken:"retirement-test-token"} as never,
    pool:{} as never,lifecycle:{} as never,railConfig:{} as never,service:{releaseRetirements:{retire,state}} as never}));
  server=await new Promise<Server>(resolve=>{const listener=app.listen(0,"127.0.0.1",()=>resolve(listener));});
  const address=server.address();if(!address||typeof address==="string") throw new Error("no listener");
  return "http://127.0.0.1:"+address.port+"/internal/release/v1/retirements";
}
it("authenticates retirement reads and writes before invoking the proof",async()=>{
  const retire=vi.fn(),state=vi.fn();const url=await start(retire,state);
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...scope,requestId:"retire-test"})})).status).toBe(401);
  expect(retire).not.toHaveBeenCalled();expect(state).not.toHaveBeenCalled();
});
it("returns scoped blockers with 409 and exposes no cached retirement observation",async()=>{
  const blockers={openOrders:1,unresolvedAuthorizations:1};
  const retire=vi.fn().mockRejectedValue(new RetirementBlocked(scope,blockers));
  const state=vi.fn().mockResolvedValue({scope,retired:false,blockers});
  const url=await start(retire,state);
  const headers={authorization:"Bearer retirement-test-token","content-type":"application/json"};
  const post=await fetch(url,{method:"POST",headers,body:JSON.stringify({...scope,requestId:"retire-test"})});
  expect(post.status).toBe(409);expect(post.headers.get("cache-control")).toBe("no-store");
  expect(await post.json()).toEqual({scope,retired:false,blockers,error:{code:"RETIREMENT_BLOCKED"}});
  const get=await fetch(url+"?"+new URLSearchParams(scope),{headers});
  expect(get.status).toBe(200);expect(get.headers.get("cache-control")).toBe("no-store");
  expect(await get.json()).toEqual({scope,retired:false,blockers});
});

it("requires the same positive provider identity as the receipt consumer",()=>{
  expect(()=>parseRetirementScope({...scope,providerAgentId:"0"})).toThrow("INVALID_RETIREMENT_SCOPE");
  expect(()=>parseRetirementScope({...scope,providerAgentId:"01"})).toThrow("INVALID_RETIREMENT_SCOPE");
  expect(parseRetirementScope(scope)).toEqual(scope);
});
