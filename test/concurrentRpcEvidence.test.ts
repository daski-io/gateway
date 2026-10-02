import { describe, expect, it } from "vitest";
import { base } from "viem/chains";
import { StandardChainEvidence } from "../src/standardRail/evidence.js";
import { createContractVerificationEndpoint, createPayerSignatureVerifier } from "../src/standardRail/payerSignature.js";
import type { Hex } from "viem";
const { startStub, policy, listing, PAYER, NONCE, TX, GROSS } =
  await import(new URL("./fixtures/releaseRpc.mjs", import.meta.url).href);

describe("concurrent paid proofs through actual viem and JSON-RPC", () => {
 it.each([1,4,6])("completes %i concurrent purchases without queue rejection or shared receipt watcher stalls", async count => {
  const stub=await startStub({latency:()=>50});
  try {
   const evidence=new StandardChainEvidence({evidenceRpcUrls:[stub.url],rpcReadMaxPerMinute:300,finalityConfirmations:5,
    environment:"mainnet",releasePrivateKey:("0x"+"11".repeat(32)) as Hex,
    manifest:{chainEvidencePolicy:{payload:policy}}} as never,base,{run:(work:()=>Promise<unknown>)=>work()} as never);
   const started=Date.now();
   await Promise.all(Array.from({length:count},async()=>{
    const order={payer:PAYER,grossAmount:GROSS.toString(),updatedAt:new Date()} as never;
    const deposit=await evidence.proveDeposit({order,listing,transactionHash:TX,paymentNonce:NONCE});
    expect(await evidence.releaseAndProve({order,listing,deposit})).toMatchObject({providerNetAmount:975000n,daskiCommissionAmount:25000n});
   }));
   // 5 reads/s necessarily takes time; no 180s watcher timeout or retry storm.
   expect(Date.now()-started).toBeLessThan(55_000);
   expect(stub.log.length).toBeLessThanOrEqual(35*count);
   for(let i=1;i<stub.log.length;i++) expect(stub.log[i].arrived-stub.log[i-1].arrived).toBeGreaterThanOrEqual(170);
  } finally {await stub.close();}
 },90_000);
 it("keeps eight contract-payer verifications within their absolute 5s deadline at 900ms RPC latency", async()=>{
  const stub=await startStub({latency:()=>900});
  try {
   const endpoint=createContractVerificationEndpoint({url:stub.url,chain:base,timeoutMs:5_000,maxPerMinute:300});
   const verifier=createPayerSignatureVerifier({accountTypes:["eoa","contract"],timeoutMs:5_000,endpoints:[endpoint]});
   const typedData={domain:{name:"DaskiStandardWallet",version:"1",chainId:8453},
    types:{Probe:[{name:"nonce",type:"bytes32"}]},primaryType:"Probe",message:{nonce:NONCE}} as const;
   const started=Date.now();
   await Promise.all(Array.from({length:8},()=>verifier.verifyPayerTypedData({payer:PAYER,typedData,
    signature:("0x"+"12".repeat(65)) as Hex,context:{field:"payer",phase:"payment_validation"}})));
   expect(Date.now()-started).toBeLessThan(5_000);
   expect(stub.log).toHaveLength(16);
  } finally {await stub.close();}
 },15_000);
});
