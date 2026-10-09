import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { custom, encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem, type Hex } from "viem";
import { orderedRpcTransport } from "../src/rpc/orderedTransport.js";
import { StandardChainEvidence } from "../src/standardRail/evidence.js";
import { ViemRegistrationEvidenceVerifier } from "../src/serviceRegistration/evidence.js";
import { StandardWalletQueries } from "../src/standardRail/walletQueries.js";
import { ViemMarketplaceChainReader } from "../src/marketplace/reader.js";
import { canonicalHash } from "../src/standardRail/canonical.js";

const hash = (n: number) => ("0x" + n.toString(16).padStart(2,"0").repeat(32)) as Hex;
const address = (n: number) => ("0x" + n.toString(16).padStart(2,"0").repeat(20)) as Hex;
const token=address(1), splitter=address(2), payer=address(3), payee=address(4), receiver=address(5), factory=address(6), implementation=address(7);
const activationHash=hash(100), releaseHash=hash(102), releaseTx=hash(12), depositTx=hash(11), deploymentTx=hash(10);
const code="0x6000" as Hex, factoryCode="0x6001" as Hex, implementationCode="0x6002" as Hex;
const outcome=hash(8), policyHash=hash(9), domain=hash(20);
const transferAbi=parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const releaseAbi=parseAbiItem("event Released(bytes32 indexed outcomeIdHash,uint64 indexed listingEpoch,uint64 indexed releaseSequence,bytes32 policyVersionHash,bytes32 listingCommitmentHash,uint256 grossAmount,uint256 providerNetAmount,uint256 daskiCommissionAmount)");
function transfer(from:Hex,to:Hex,value:bigint,block:bigint,tx:Hex,index:number) {
 return {address:token,blockNumber:block,blockHash:hash(Number(block)),transactionHash:tx,transactionIndex:0,logIndex:index,removed:false,
   topics:encodeEventTopics({abi:[transferAbi],eventName:"Transfer",args:{from,to}}),data:encodeAbiParameters([{type:"uint256"}],[value])};
}
// Every call made by the real evidence methods crosses the real ordered RPC
// transport. Only wire answers are synthetic; no proof/admission method is stubbed.
function rpc(handlers:Record<string,(args:any)=>unknown>, latency:number) {
 const calls:string[]=[];
 const request=orderedRpcTransport(custom({request:async({method,params}:any)=>{
   calls.push(method); await new Promise(resolve=>setTimeout(resolve,latency));
   if(!handlers[method])throw new Error("Unexpected RPC method "+method);
   return handlers[method]!(params?.[0]);
 }}),{scope:"required-evidence-"+randomUUID(),maxPerMinute:300})({retryCount:0}).request;
 const client=Object.fromEntries(Object.keys(handlers).map(method=>[method,(args:unknown)=>request({method,params:[args]} as never)]));
 return {client,calls};
}
async function finish<T>(work:Promise<T>):Promise<T> {
 const result=work.then(value=>({value}),error=>({error}));
 await vi.runAllTimersAsync();
 const settled=await result;
 if("error" in settled)throw settled.error;
 return settled.value;
}

describe("required evidence through the bounded RPC transport",()=>{
 it.each([50,200])("proves a released payment at the default budget and %i ms archive latency",async latency=>{
  vi.useFakeTimers();
  try{
   const commitment=hash(21);
   const released={address:splitter,blockNumber:102n,blockHash:releaseHash,transactionHash:releaseTx,transactionIndex:0,logIndex:2,removed:false,
     topics:encodeEventTopics({abi:[releaseAbi],eventName:"Released",args:{outcomeIdHash:outcome,listingEpoch:1n,releaseSequence:1n}}),
     data:encodeAbiParameters([{type:"bytes32"},{type:"bytes32"},{type:"uint256"},{type:"uint256"},{type:"uint256"}],[policyHash,commitment,1000000n,975000n,25000n])};
   const depositLog=transfer(payer,splitter,1000000n,101n,depositTx,0);
   const receipt={status:"success",transactionHash:releaseTx,blockNumber:102n,blockHash:releaseHash,transactionIndex:0,
     logs:[transfer(splitter,payee,975000n,102n,releaseTx,0),transfer(splitter,receiver,25000n,102n,releaseTx,1),released]};
   const facts:Record<string,unknown>={balanceOf:0n,releaseSequence:0n,canonicalToken:token,providerPayee:payee,
     daskiCommissionReceiver:receiver,commissionBps:250,listingCommitmentHash:commitment,policyVersionHash:policyHash,outcomeIdHash:outcome,listingEpoch:1n,DOMAIN_SEPARATOR:domain};
   const {client,calls}=rpc({
     getBlockNumber:()=>120n,getBlock:()=>({number:100n,hash:activationHash}),
     getBytecode:({address:target})=>target===implementation?implementationCode:code,
     getStorageAt:()=>("0x"+"00".repeat(12)+implementation.slice(2)),
     readContract:({functionName})=>facts[functionName],
     waitForTransactionReceipt:()=>receipt,getTransactionReceipt:()=>receipt,
     getLogs:({event})=>event.name==="Released"?[released]:[depositLog],
   },latency);
   const config={finalityConfirmations:1,manifest:{chainEvidencePolicy:{payload:{
     maximumLogPageEvents:100,canonicalToken:token,canonicalTokenRuntimeCodeHash:keccak256(code),
     tokenImplementationAddress:implementation,tokenImplementationRuntimeCodeHash:keccak256(implementationCode),
     tokenImplementationSlot:hash(1),tokenDomainSeparator:domain,
   }}}};
   const evidence=Object.assign(Object.create(StandardChainEvidence.prototype),{config,clients:[{host:"offline",client}]}) as StandardChainEvidence;
   const listing={manifest:{payload:{splitterAddress:splitter,splitterActivationBlockNumber:"100",splitterActivationBlockHash:activationHash,
     splitterStartingTokenBalance:"0",splitterStartingReleaseSequence:"0",splitterRuntimeCodeHash:keccak256(code),
     listingCommitmentHash:commitment,policyVersionHash:policyHash,outcomeIdHash:outcome,listingEpoch:"1"}},
     commitment:{payload:{canonicalToken:token,providerPayee:payee,daskiCommissionReceiver:receiver,commissionBps:250}}};
   const result=await finish(evidence.releaseAndProve({listing:listing as never,order:{payer,grossAmount:"1000000"} as never,
     deposit:{transactionHash:depositTx,blockNumber:101n,blockHash:hash(101),transactionIndex:0,logIndex:0} as never}));
   expect(result).toMatchObject({transactionHash:releaseTx,providerNetAmount:975000n,daskiCommissionAmount:25000n,releaseSequence:1n});
   expect(calls.filter(call=>call==="readContract")).toHaveLength(11);
  }finally{vi.useRealTimers();}
 });
 it.each([50,200])("verifies a paid splitter registration at 300/min and %i ms latency",async latency=>{
  vi.useFakeTimers();
  try{
   const preparation={payload:{splitterDeploymentSalt:hash(30),listingEpoch:"1",providerPayee:payee}};
   const commitment=canonicalHash(preparation),transactionData="0x1234",listingKey=outcome;
   const deployedAbi=parseAbiItem("event OutcomeSplitterDeployed(address indexed splitter,bytes32 indexed salt,bytes32 indexed listingKey,uint64 listingEpoch,bytes32 listingCommitmentHash)");
   const receipt={status:"success",transactionHash:deploymentTx,from:payee,to:factory,blockNumber:100n,blockHash:activationHash,
     logs:[{address:factory,blockNumber:100n,blockHash:activationHash,transactionHash:deploymentTx,removed:false,
       topics:encodeEventTopics({abi:[deployedAbi],eventName:"OutcomeSplitterDeployed",args:{splitter,salt:hash(30),listingKey}}),
       data:encodeAbiParameters([{type:"uint64"},{type:"bytes32"}],[1n,commitment])}]};
   const facts:Record<string,unknown>={canonicalChainId:84532n,canonicalToken:token,providerPayee:payee,daskiCommissionReceiver:receiver,
     commissionBps:250,policyVersionHash:policyHash,outcomeIdHash:listingKey,listingCommitmentHash:commitment,listingEpoch:1n,releaseSequence:0n,balanceOf:0n};
   const {client,calls}=rpc({
     getTransaction:()=>({hash:deploymentTx,from:payee,to:factory,input:transactionData,value:0n,blockNumber:100n,blockHash:activationHash}),
     getTransactionReceipt:()=>receipt,getBlock:()=>({number:100n,hash:activationHash}),
     getCode:({address:target})=>target===factory?factoryCode:code,
     readContract:({functionName})=>facts[functionName],
   },latency);
   const verifier=Object.assign(Object.create(ViemRegistrationEvidenceVerifier.prototype),{
     clients:[{host:"offline",client}],config:{chainId:84532,finalityTag:"finalized"},policy:{
       canonicalToken:token,daskiCommissionReceiver:receiver,commissionBps:250,policyVersionHash:policyHash,splitterFactory:factory,splitterFactoryRuntimeCodeHash:keccak256(factoryCode),
     }});
   const result=await finish(verifier.verifySplitter({registration:{providerSigner:payee},listing:{
     preparation,transaction:{data:transactionData},splitterAddress:splitter,listingKey,
   },transactionHash:deploymentTx}));
   expect(result).toMatchObject({splitterDeploymentTransactionHash:deploymentTx,splitterStartingTokenBalance:"0",splitterStartingReleaseSequence:"0"});
   expect(calls.filter(call=>call==="readContract")).toHaveLength(11);
  }finally{vi.useRealTimers();}
 });
});

it("reads all 100 wallet orders through the bounded transport at one pinned block",async()=>{
 vi.useFakeTimers();
 try{
  const rows=Array.from({length:100},(_,i)=>({order_id:"order-"+i,order_handle:"handle-"+i,intent_id:"intent-"+i,
    order_key:Buffer.alloc(32,i),provider_agent_id:"7",outcome_id:"example",state:"FULFILLED",gross_amount:"1000000",
    canonical_listing:{commitment:{payload:{serviceId:hash(4)}}},created_at:new Date(),updated_at:new Date()}));
  const blocks:bigint[]=[];
  const {client,calls}=rpc({getBlock:()=>({number:100n}),readContract:({blockNumber})=>{blocks.push(blockNumber);return {orderKey:hash(0)};}},200);
  const queries=Object.assign(Object.create(StandardWalletQueries.prototype),{
    pool:{query:async()=>({rows})},wallet:{consume:async()=>({payer}),orderCursorBinding:()=>({})},
    clients:[{host:"offline",client}],reputationContract:address(9),finalityTag:"finalized",
  }) as StandardWalletQueries;
  const result=await finish(queries.listOrders({payer,limit:100,cursor:null,authorization:{} as never}));
  expect(result.orders).toHaveLength(100);expect(result.nextCursor).toBeNull();
  // One record per order plus the contract version that gates recoveries; the
  // stub answers no version, so no order's recovery is read.
  expect(calls.filter(call=>call==="readContract")).toHaveLength(101);expect(new Set(blocks)).toEqual(new Set([100n]));
  expect(result.orders.every(order=>order.reputation.recovery===null)).toBe(true);
 }finally{vi.useRealTimers();}
});


it("reads a maximum registry page without overflowing the ordered transport",async()=>{
 vi.useFakeTimers();
 try{
  const blocks:bigint[]=[];
  const {client,calls}=rpc({getBlock:()=>({number:100n}),readContract:({functionName,blockNumber,args})=>{
    blocks.push(blockNumber);
    switch(functionName){
      case "getProviderCount":return 100n;
      case "getProviderIdsPaginated":return Array.from({length:100},(_,i)=>BigInt(i+1));
      case "getProvider":return {agentId:args[0],registrationTime:1n,isActive:true};
      case "ownerOf":case "getAgentWallet":return payer;
      case "tokenURI":return "https://provider.example.test/card";
      default:throw new Error("Unexpected registry read "+functionName);
    }
  }},50);
  const reader=Object.assign(Object.create(ViemMarketplaceChainReader.prototype),{
    clients:[{host:"offline",client}],finalityTag:"finalized",addresses:{providerRegistry:address(8),identityRegistry:address(9)},
  }) as ViemMarketplaceChainReader;
  const result=await finish(reader.listProviders(0,100)) as {providers:unknown[];total:string;finalizedBlock:string};
  expect(result.providers).toHaveLength(100);expect(result.total).toBe("100");expect(result.finalizedBlock).toBe("100");
  expect(calls.filter(call=>call==="readContract")).toHaveLength(402);
  expect(new Set(blocks)).toEqual(new Set([100n]));
 }finally{vi.useRealTimers();}
});
