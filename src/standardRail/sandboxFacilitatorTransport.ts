import {encodeAbiParameters,keccak256,type Hex} from "viem";
export interface SandboxFacilitatorTransport {origin:string;token:string;authorizationKeys:ReadonlySet<string>}
const names=["DASKI_SANDBOX_FACILITATOR_TRANSPORT_ORIGIN","DASKI_SANDBOX_FACILITATOR_TRANSPORT_TOKEN","DASKI_SANDBOX_FACILITATOR_AUTHORIZATION_KEYS_JSON"] as const;
export function parseSandboxFacilitatorTransport(env:NodeJS.ProcessEnv):SandboxFacilitatorTransport|undefined {
 if(!names.some(name=>env[name]!==undefined))return undefined;
 if(env.CHAIN_ID!=="84532"||env.STANDARD_RAIL_ENVIRONMENT!=="testnet"||env.PUBLIC_URL!=="https://sandbox-gateway.daski.io")
  throw new Error("Sandbox facilitator transport is forbidden outside the explicit sandbox");
 const url=new URL(env.DASKI_SANDBOX_FACILITATOR_TRANSPORT_ORIGIN??"");
 if(url.protocol!=="https:"||url.username||url.password||url.port||url.pathname!=="/"||url.search||url.hash||
  !/^sandbox-[a-z0-9-]+\.daski\.io$/.test(url.hostname))throw new Error("Sandbox facilitator transport requires an owned HTTPS sandbox origin");
 const token=env.DASKI_SANDBOX_FACILITATOR_TRANSPORT_TOKEN;
 if(!token||!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw new Error("Separate sandbox facilitator transport authority required");
 let keys:unknown;
 try{keys=JSON.parse(env.DASKI_SANDBOX_FACILITATOR_AUTHORIZATION_KEYS_JSON??"");}catch{throw new Error("Sandbox authorization allowlist required");}
 if(!Array.isArray(keys)||!keys.length||keys.length>128||keys.some(k=>typeof k!=="string"||!/^0x[a-f0-9]{64}$/.test(k))||new Set(keys).size!==keys.length)
  throw new Error("Exact distinct sandbox payment authorization keys required");
 if(env.CDP_FACILITATOR_BASE_URL&&env.CDP_FACILITATOR_BASE_URL!=="https://api.cdp.coinbase.com/platform/v2/x402")
  throw new Error("Sandbox transport preserves the official logical facilitator endpoint");
 return {origin:url.origin,token,authorizationKeys:new Set(keys)};
}
export function facilitatorTransportRequest(config:SandboxFacilitatorTransport|undefined,logicalUrl:string,operation:string,body?:unknown) {
 if(!config)return {url:logicalUrl,headers:{} as Record<string,string>};
 if(logicalUrl!=="https://api.cdp.coinbase.com/platform/v2/x402/"+operation||!["supported","verify","settle"].includes(operation))
  throw new Error("Unreviewed facilitator transport operation");
 if(operation!=="supported") {
  const value=body as {paymentPayload?:{accepted?:{network?:string;asset?:string};payload?:{authorization?:{from?:string;nonce?:string}}};paymentRequirements?:{network?:string;asset?:string}};
  const accepted=value?.paymentPayload?.accepted,auth=value?.paymentPayload?.payload?.authorization,requirements=value?.paymentRequirements;
  if(accepted?.network!=="eip155:84532"||requirements?.network!=="eip155:84532"||accepted.asset?.toLowerCase()!==requirements.asset?.toLowerCase()||
   !/^0x[a-f0-9]{40}$/i.test(accepted?.asset??"")||!/^0x[a-f0-9]{40}$/i.test(auth?.from??"")||!/^0x[a-f0-9]{64}$/i.test(auth?.nonce??""))
   throw new Error("Payment is outside the exact sandbox transport scope");
  const key=keccak256(encodeAbiParameters([{type:"uint256"},{type:"address"},{type:"address"},{type:"bytes32"}],
   [84532n,accepted!.asset as Hex,auth!.from as Hex,auth!.nonce as Hex]));
  if(!config.authorizationKeys.has(key))throw new Error("Payment authorization is not allowed by the sandbox fixture");
 }
 return {url:config.origin+"/facilitator/"+operation,headers:{"x-daski-sandbox-fixture-token":config.token}};
}
