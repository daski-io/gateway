import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import dns from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { Readable, Writable } from 'node:stream';

assert.equal(process.env.DASKI_ISOLATED_STARTUP_PROOF, '1', 'test transport requires explicit isolated proof');
const factsPath=process.env.DASKI_PROOF_RPC_FACTS_PATH;
assert.ok(factsPath,'isolated RPC facts file is required');
const factsInfo=statSync(factsPath);
assert.ok(factsInfo.isFile() && factsInfo.size<=16*1024*1024,'isolated RPC facts must be a bounded regular file');
const facts = JSON.parse(readFileSync(factsPath,'utf8'));
assert.equal(facts.schemaVersion, 1);
const routes = JSON.parse(process.env.DASKI_PROOF_PROVIDER_ROUTES ?? '[]');
for (const route of routes) {
  assert.equal(new URL(route.origin).protocol,'https:');
  const target=new URL(route.target);
  assert.equal(target.protocol,'http:');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
  assert.ok(Array.isArray(route.paths) && Array.isArray(route.methods));
}
const facilitator = new URL(process.env.DASKI_PROOF_FACILITATOR_URL);
assert.equal(facilitator.protocol,'https:');
const allowedRpc = 'https://rpc.reliability.invalid/';
const word = `0x${'0'.repeat(64)}`;
function answer(request) {
  const [first, second] = request.params ?? [];
  let result;
  switch (request.method) {
    case 'eth_chainId': result='0x14a34'; break;
    case 'eth_blockNumber': result=facts.blockNumber; break;
    case 'eth_getCode': result=facts.code[first.toLowerCase()]; break;
    case 'eth_getStorageAt': result=facts.storage[`${first.toLowerCase()}:${second.toLowerCase()}`]; break;
    case 'eth_call': result=facts.calls[`${first.to.toLowerCase()}:${first.data.toLowerCase()}`]; break;
    case 'eth_getBlockByNumber': result={number:facts.blockNumber,hash:word,parentHash:word,
      timestamp:'0x1',transactions:[],gasLimit:'0x1',gasUsed:'0x0',baseFeePerGas:'0x1',difficulty:'0x0',
      extraData:'0x',logsBloom:`0x${'0'.repeat(512)}`,miner:`0x${'0'.repeat(40)}`,mixHash:word,
      nonce:'0x0000000000000000',receiptsRoot:word,sha3Uncles:word,size:'0x1',stateRoot:word,transactionsRoot:word,uncles:[]}; break;
    default: throw new Error(`Unconfigured RPC method: ${request.method}`);
  }
  assert.notEqual(result, undefined, `Unconfigured RPC fact: ${request.method}`);
  return {jsonrpc:'2.0',id:request.id,result};
}
globalThis.fetch = async (url, options) => {
  assert.equal(new URL(String(url)).href, allowedRpc, 'unconfigured network request blocked');
  const input=JSON.parse(options.body);
  return Response.json(Array.isArray(input) ? input.map(answer) : answer(input));
};
dns.lookup = async hostname => {
  assert.ok(hostname === facilitator.hostname || routes.some(route=>new URL(route.origin).hostname===hostname),'unconfigured DNS blocked');
  return [{address:'8.8.8.8',family:4}];
};
https.request = (target, options, callback) => {
  const parsed=new URL(target);
  const route=routes.find(route=>route.origin===parsed.origin && route.paths.includes(parsed.pathname) && route.methods.includes(options.method));
  if(route) {
    const local=new URL(parsed.pathname+parsed.search,route.target);
    return http.request(local,{method:options.method,headers:options.headers,signal:options.signal},callback);
  }
  assert.equal(target, `${facilitator.href.replace(/\/$/,'')}/supported`, 'only capability read permitted');
  assert.equal(options.method, 'GET');
  const request = new Writable({write(_chunk,_encoding,done){done();}});
  request.on('finish', () => {
    const response=Readable.from([Buffer.from(JSON.stringify({kinds:[{x402Version:2,scheme:'exact',network:'eip155:84532'}],extensions:[],signers:{}}))]);
    response.statusCode=200; response.statusMessage='OK'; response.headers={'content-type':'application/json'};
    callback(response);
  });
  return request;
};
syncBuiltinESMExports();
