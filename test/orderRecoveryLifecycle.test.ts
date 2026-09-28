import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { StandardRailService } from "../src/standardRail/service.js";
import { validateSupportRequest } from "../src/standardRail/supportRequest.js";
import type { StandardListing, StandardOrderRecord } from "../src/standardRail/types.js";

const signer=privateKeyToAccount(`0x${"12".repeat(32)}`);
const hash=(n:string)=>`0x${n.repeat(64)}` as Hex;

describe("recovery lifecycle projection",()=>{
  it("accepts recovery artifacts on a fresh signed pull, without redispatch or changing original failure",async()=>{
    const now=Math.floor(Date.now()/1000);
    const order={orderId:"ord",providerTaskId:"task",state:"PROVIDER_FAILED",orderKey:hash("1")} as StandardOrderRecord;
    const listing={commitment:{payload:{providerAuthorityKey:signer.address,providerTerminalAttestationKey:signer.address}}} as StandardListing;
    const terminal={orderId:"ord",taskId:"task",state:"failed",resultHash:hash("2"),completedAt:now-60};
    const payload={orderId:"ord",taskId:"task",state:"failed",result:{artifacts:[]},
      operations:{schemaVersion:1,revision:2,observedAt:now,fulfillment:null,support:null,
        recovery:{recoveryId:"recovery",reviewId:"review",state:"completed",startedAt:now-10,completedAt:now,resultHash:hash("3"),
          originalTerminal:{state:"failed",completedAt:terminal.completedAt,resultHash:terminal.resultHash}}},
      terminalAttestation:{payload:terminal,signature:await signer.signMessage({message:{raw:canonicalHash(terminal)}})}};
    const response={...payload,signature:await signer.signMessage({message:{raw:canonicalHash(payload)}})};
    const persistOperations=vi.fn(async()=>undefined);
    const transition=vi.fn();
    const service=Object.assign(Object.create(StandardRailService.prototype),{
      store:{persistOperations,transition},validateResponse:vi.fn(async()=>undefined),signedReceipt:async()=>null,
    }) as {applyLifecycleResult:(order:StandardOrderRecord,listing:StandardListing,response:unknown,action:string,handle:string)=>Promise<unknown>};
    await expect(service.applyLifecycleResult(order,listing,response,"artifact","handle")).resolves.toMatchObject({
      orderState:"PROVIDER_FAILED",state:"failed",fulfillmentState:"recovered",result:{artifacts:[]},
    });
    expect(persistOperations).toHaveBeenCalledExactlyOnceWith("ord",payload.operations,payload.terminalAttestation);
    expect(transition).not.toHaveBeenCalled();
    await expect(service.applyLifecycleResult(order,listing,{...response,operations:{...payload.operations,revision:99}},"artifact","handle"))
      .rejects.toThrow("PROVIDER_LIFECYCLE_SIGNATURE_INVALID");
    expect(persistOperations).toHaveBeenCalledTimes(1);
  });

  it("requires the logical request ID inside the signed support body",()=>{
    expect(()=>validateSupportRequest("support",{requestId:"retry_1",message:"Please help"})).not.toThrow();
    expect(()=>validateSupportRequest("support",{message:"Please help"})).toThrow();
    expect(()=>validateSupportRequest("support",{requestId:"bad id",message:"Please help"})).toThrow();
    expect(()=>validateSupportRequest("support",{requestId:"retry_1",message:"Please help",unsignedOverride:true})).toThrow();
    expect(()=>validateSupportRequest("support",{requestId:"retry_1",message:"  "})).toThrow();
    expect(()=>validateSupportRequest("support",{requestId:"retry_1",message:"control\u0000"})).toThrow();
  });

  it("accepts the requested support receipt while preserving original terminal evidence and the latest observation",async()=>{
    const now=Math.floor(Date.now()/1000);
    const order={orderId:"ord",providerTaskId:"task",state:"PROVIDER_FAILED",orderKey:hash("1")} as StandardOrderRecord;
    const listing={commitment:{payload:{providerAuthorityKey:signer.address,providerTerminalAttestationKey:signer.address}}} as StandardListing;
    const terminal={orderId:"ord",taskId:"task",state:"failed",resultHash:hash("2"),completedAt:now-60};
    const reviewId="11111111-1111-4111-8111-111111111111",messageId="22222222-2222-4222-8222-222222222222";
    const payload={orderId:"ord",taskId:"task",state:"failed",
      result:{supportReceipt:{requestId:"older_request",messageId,reviewId,acceptedAt:new Date().toISOString()}},
      operations:{schemaVersion:1,revision:2,observedAt:now,fulfillment:null,recovery:null,
        support:{reviewId,status:"open",lastAcceptedRequest:{requestId:"newer_request",messageId,acceptedAt:now}}},
      terminalAttestation:{payload:terminal,signature:await signer.signMessage({message:{raw:canonicalHash(terminal)}})}};
    const response={...payload,signature:await signer.signMessage({message:{raw:canonicalHash(payload)}})};
    const persistOperations=vi.fn(async()=>undefined),transition=vi.fn(),validateResponse=vi.fn();
    const service=Object.assign(Object.create(StandardRailService.prototype),{
      store:{persistOperations,transition},validateResponse,signedReceipt:async()=>null,
    }) as {applyLifecycleResult:(order:StandardOrderRecord,listing:StandardListing,response:unknown,action:string,handle:string,request:Record<string,unknown>)=>Promise<unknown>};
    await expect(service.applyLifecycleResult(order,listing,response,"support","handle",{requestId:"older_request"}))
      .resolves.toMatchObject({result:payload.result,orderState:"PROVIDER_FAILED"});
    expect(validateResponse).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(persistOperations).toHaveBeenCalledExactlyOnceWith("ord",payload.operations,payload.terminalAttestation);
    await expect(service.applyLifecycleResult(order,listing,response,"support","handle",{requestId:"unrelated_request"}))
      .rejects.toThrow("PROVIDER_SUPPORT_RECEIPT_BINDING_INVALID");
    expect(persistOperations).toHaveBeenCalledTimes(1);
  });

  it("refuses a payer-aware quote before provider admission when payerAddress is missing",async()=>{
    const providerFetch=vi.fn();
    const service=Object.assign(Object.create(StandardRailService.prototype),{
      assertAdmissionOpen:vi.fn(),assertRailFence:async()=>undefined,
      listing:async()=>({purchaseReadiness:"payer_dns"}),validateRequest:async()=>undefined,providerFetch,
    }) as StandardRailService;
    await expect(service.issueChallenge({providerAgentId:"7",outcomeId:"create-mailbox",body:{}}))
      .rejects.toMatchObject({code:"REQUEST_SCHEMA_INVALID"});
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
