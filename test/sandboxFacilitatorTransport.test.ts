import {loadConfig} from "../src/config.js";
import {describe,it,expect} from "vitest";
import {encodeAbiParameters,keccak256,type Hex} from "viem";
import {parseSandboxFacilitatorTransport,facilitatorTransportRequest} from "../src/standardRail/sandboxFacilitatorTransport.js";
const token="x".repeat(40),asset=("0x"+"11".repeat(20)) as Hex,payer=("0x"+"22".repeat(20)) as Hex,nonce=("0x"+"33".repeat(32)) as Hex;
const key=keccak256(encodeAbiParameters([{type:"uint256"},{type:"address"},{type:"address"},{type:"bytes32"}],[84532n,asset,payer,nonce]));
const env=()=>({CHAIN_ID:"84532",STANDARD_RAIL_ENVIRONMENT:"testnet",PUBLIC_URL:"https://sandbox-gateway.daski.io",
 DASKI_SANDBOX_FACILITATOR_TRANSPORT_ORIGIN:"https://sandbox-facilitator.daski.io",DASKI_SANDBOX_FACILITATOR_TRANSPORT_TOKEN:token,
 DASKI_SANDBOX_FACILITATOR_AUTHORIZATION_KEYS_JSON:JSON.stringify([key])});
const body=()=>({paymentPayload:{accepted:{network:"eip155:84532",asset},payload:{authorization:{from:payer,nonce}}},paymentRequirements:{network:"eip155:84532",asset}});
describe("sandbox facilitator transport",()=>{
 it("is absent by default and rejects any production presence before other startup work",()=>{
  expect(parseSandboxFacilitatorTransport({CHAIN_ID:"8453"})).toBeUndefined();
  expect(()=>loadConfig({CHAIN_ID:"8453",DASKI_SANDBOX_FACILITATOR_TRANSPORT_ORIGIN:""})).toThrow(/forbidden/);
  for(const patch of [{CHAIN_ID:"8453"},{CHAIN_ID:undefined},{PUBLIC_URL:"https://gateway.daski.io"},{STANDARD_RAIL_ENVIRONMENT:"production"}])
   expect(()=>parseSandboxFacilitatorTransport({...env(),...patch})).toThrow(/forbidden/);
 });
 it("preserves logical CDP URL and transports only allowlisted exact Sepolia authorizations",()=>{
  const config=parseSandboxFacilitatorTransport(env())!,logical="https://api.cdp.coinbase.com/platform/v2/x402/verify";
  const request=facilitatorTransportRequest(config,logical,"verify",body());
  expect(request.url).toBe("https://sandbox-facilitator.daski.io/facilitator/verify");expect(request.headers["x-daski-sandbox-fixture-token"]).toBe(token);
  expect(facilitatorTransportRequest(undefined,logical,"verify",body())).toEqual({url:logical,headers:{}});
  expect(()=>facilitatorTransportRequest(config,logical.replace("coinbase.com","evil.example"),"verify",body())).toThrow(/Unreviewed/);
  expect(()=>facilitatorTransportRequest(config,logical,"verify",{...body(),paymentRequirements:{network:"eip155:8453",asset}})).toThrow(/scope/);
  const other=body();other.paymentPayload.payload.authorization.nonce=("0x"+"44".repeat(32)) as Hex;
  expect(()=>facilitatorTransportRequest(config,logical,"verify",other)).toThrow(/not allowed/);
 });
 it("requires owned HTTPS, separate authority, and distinct bounded authorization keys",()=>{
  for(const patch of [{DASKI_SANDBOX_FACILITATOR_TRANSPORT_ORIGIN:"https://attacker.example"},
   {DASKI_SANDBOX_FACILITATOR_TRANSPORT_ORIGIN:"http://sandbox-facilitator.daski.io"},
   {DASKI_SANDBOX_FACILITATOR_TRANSPORT_TOKEN:"short"},
   {DASKI_SANDBOX_FACILITATOR_AUTHORIZATION_KEYS_JSON:JSON.stringify([key,key])}])
   expect(()=>parseSandboxFacilitatorTransport({...env(),...patch})).toThrow();
 });
});
