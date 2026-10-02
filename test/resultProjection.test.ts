import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { projectContractResult } from "../src/standardRail/resultProjection.js";
import { compileClosedResponseSchema } from "../src/standardRail/schema.js";
import { StandardRailCatalog } from "../src/standardRail/catalog.js";
import { StandardRailService } from "../src/standardRail/service.js";
import { canonicalHash } from "../src/standardRail/canonical.js";

const string={type:"string",maxLength:4096};
const schema={type:"object",properties:{domain:string,authCode:string,nextSteps:{type:"array",items:string}},
 required:["domain","authCode","nextSteps"],additionalProperties:false};
function task() { return {id:"task",status:{state:"TASK_STATE_COMPLETED",message:{role:"ROLE_AGENT",parts:[]}},
 artifacts:[
  {artifactId:"code",name:"transfer_auth_code",parts:[{kind:"data",data:{domain:"example.test",authCode:"revealed-code",expiresAt:"2027-01-01"}}]},
  {artifactId:"transfer",name:"domain_transferred_out",parts:[{kind:"data",data:{domain:"example.test",nextSteps:"Provide this code to the registrar",timestamp:"2026-10-02"}}]},
 ]}; }
function catalog() {
 return Object.assign(Object.create(StandardRailCatalog.prototype),{
  withinSchemaBudget:async(_listing:unknown,validate:()=>void)=>validate(),
  compiled:(listing:any)=>({response:compileClosedResponseSchema(listing.responseSchema)}),
 });
}
describe("paid result projection",()=>{
 it("merges declared transfer fields without rewriting the signed task",()=>{
  const original=task(),before=JSON.stringify(original);
  expect(projectContractResult(schema,original)).toEqual({domain:"example.test",authCode:"revealed-code",nextSteps:["Provide this code to the registrar"]});
  expect(JSON.stringify(original)).toBe(before);
 });
 it.each([false,true])("projects legacy completed mailbox renewal without treating restored=%s as renewal failure",restored=>{
  const original={id:"task",status:{state:"TASK_STATE_COMPLETED"},artifacts:[{name:"mailbox_renewed",parts:[{kind:"data",data:{address:"a@example.test",expiresAt:"2027-01-01",restored}}]}]};
  const paid={type:"object",properties:{address:string,expiresAt:string,renewed:{type:"boolean"}},required:["address","expiresAt","renewed"],additionalProperties:false};
  const validate=compileClosedResponseSchema(paid);
  expect(validate(projectContractResult(paid,original))).toBe(true);
  expect(projectContractResult(paid,original)).toEqual({address:"a@example.test",expiresAt:"2027-01-01",renewed:true});
  expect(()=>projectContractResult(paid,{...original,status:{state:"TASK_STATE_WORKING"}})).toThrow("not completed");
  expect(()=>projectContractResult(paid,{...original,artifacts:[{...original.artifacts[0],name:"unrelated"}]})).toThrow("Undeclared");
 });
 it("retains task contracts and rejects conflicting artifact fields",()=>{
  const original=task();
  expect(projectContractResult({properties:{id:string,status:{type:"object"}}},original)).toBe(original);
  (original.artifacts[1]!.parts[0]!.data as any).domain="another.test";
  expect(()=>projectContractResult(schema,original)).toThrow("Conflicting");
 });
 it("maps the signed terminal state for flat lifecycle contracts and still checks all raw output",async()=>{
  const original=task(),listing={responseSchema:{type:"object",properties:{domain:string,authCode:string,nextSteps:{type:"array",items:string},status:string},required:["domain","status"],additionalProperties:false}};
  await expect(catalog().validateResponse(listing,original)).resolves.toBeUndefined();
  (original.artifacts[0]!.parts[0]!.data as any).ignored="<script>active</script>";
  await expect(catalog().validateResponse(listing,original)).rejects.toThrow("ACTIVE_CONTENT");
 });
 it("delivers a signed artifact with original bytes and rejects signature, task, and exact-schema substitution",async()=>{
  const account=privateKeyToAccount(("0x"+"11".repeat(32)) as Hex);
  const order={orderId:"order",providerTaskId:"task",state:"FULFILLED",orderKey:"key"};
  const listing={responseSchema:schema,commitment:{payload:{providerAuthorityKey:account.address,providerTerminalAttestationKey:account.address}}};
  const service=Object.assign(Object.create(StandardRailService.prototype),{catalog:catalog(),store:{persistOperations:vi.fn()},signedReceipt:async()=>({})});
  async function response(result=task()) {
   const payload={orderId:"order",taskId:"task",state:"completed",resultHash:canonicalHash(result),completedAt:Math.floor(Date.now()/1000)};
   const unsigned={orderId:"order",taskId:"task",state:"completed",result,
    operations:{schemaVersion:1,revision:0,observedAt:Math.floor(Date.now()/1000),fulfillment:null,support:null,recovery:null},
    terminalAttestation:{payload,signature:await account.signMessage({message:{raw:canonicalHash(payload)}})}};
   return {...unsigned,signature:await account.signMessage({message:{raw:canonicalHash(unsigned)}})};
  }
  const signed=await response();
  const delivered=await service.applyLifecycleResult(order,listing,signed,"artifact","handle");
  expect(delivered.result).toEqual(signed.result);
  expect(delivered.signature).toBe(signed.signature);
  const changed=structuredClone(signed);(changed.result.artifacts[0]!.parts[0]!.data as any).authCode="tampered";
  await expect(service.applyLifecycleResult(order,listing,changed,"artifact","handle")).rejects.toThrow();
  const otherTask=task();otherTask.id="another-task";
  await expect(service.applyLifecycleResult(order,listing,await response(otherTask),"artifact","handle")).rejects.toThrow();
  await expect(service.applyLifecycleResult(order,{...listing,responseSchema:{...schema,required:[...schema.required,"missing"],properties:{...schema.properties,missing:string}}},signed,"artifact","handle")).rejects.toThrow();
 });
});


it.each(["oversized", "deep", "long-key", "file", "undeclared", "failed"])("rejects %s raw output hidden by a flat projection", async kind => {
 const original:any=task();
 if(kind==="oversized") original.status.message.parts.push({kind:"text",text:"x".repeat(300_000)});
 if(kind==="deep") {let cursor:any={};original.extra=cursor;for(let i=0;i<30;i++){cursor.n={};cursor=cursor.n;}}
 if(kind==="long-key") original.artifacts[0].parts[0].data["x".repeat(200)]="hidden";
 if(kind==="file") original.artifacts.push({name:"unrelated",parts:[{kind:"file",file:{url:"https://evil.example/payload.exe"}}]});
 if(kind==="undeclared") original.artifacts[0].parts[0].data.unlisted="hidden";
 if(kind==="failed") original.status.state="TASK_STATE_FAILED";
 await expect(catalog().validateResponse({responseSchema:schema},original)).rejects.toThrow();
});


it("validates retained paid schemas against actual provider result-builder fixtures",async()=>{
 const {readFileSync}=await import("node:fs");
 const fixture=JSON.parse(readFileSync(new URL("./fixtures/retainedPaidResults.json",import.meta.url),"utf8"));
 const cases=fixture.cases.map((item:any)=>({...item,schema:fixture.schemas[item.schema],result:fixture.results[item.result]}));
 expect(cases.length).toBeGreaterThan(100);
 for(const item of cases){
  const before=JSON.stringify(item.result);
  try{await catalog().validateResponse({responseSchema:item.schema},item.result);}
  catch(error){throw new Error([item.version,item.product,item.label,item.kind].join(" ")+": "+String(error));}
  expect(JSON.stringify(item.result)).toBe(before);
 }
});
