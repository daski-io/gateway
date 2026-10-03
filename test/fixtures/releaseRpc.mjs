// Local JSON-RPC stub for a CONSISTENT deposit + release history, so the real
// StandardChainEvidence.proveDeposit and releaseAndProve can both succeed, and
// for a sanctions oracle (behind multicall3) that clears every account, so its
// assertNotSanctioned succeeds. Plain HTTP on 127.0.0.1 (startStub) or an
// in-process fetch for simulated time (fetchStub); no real chain. Optional
// per-call latency.
import http from "node:http";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, multicall3Abi, pad, toHex, encodeEventTopics, parseAbiItem, toFunctionSelector, getAddress } from "viem";

export const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const ORACLE = "0x" + "3c".repeat(20);
export const ORACLE_CODE = "0x6080600404";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
export const IMPLEMENTATION = "0x2ce6311ddae708829bc0784c967b7d77d19fd779";
export const SPLITTER = "0x" + "5a".repeat(20);
export const PAYEE = "0x" + "6b".repeat(20);
export const RECEIVER = "0x" + "7c".repeat(20);
export const PAYER = "0x" + "22".repeat(20);
export const NONCE = "0x" + "ab".repeat(32);
export const TX = "0x" + "cd".repeat(32);
export const RTX = "0x" + "ef".repeat(32);
export const GROSS = 1_000_000n, BPS = 250, COMMISSION = GROSS * 250n / 10_000n, NET = GROSS - COMMISSION;
export const A = 39_990_000, D = 39_999_000, R = 39_999_010;
const TOKEN_CODE = "0x6080600101", IMPL_CODE = "0x6080600202", SPLITTER_CODE = "0x6080600303";
const DOMAIN = "0x" + "d0".repeat(32);
export const OIH = "0x" + "a1".repeat(32), PVH = "0x" + "a2".repeat(32), LCH = "0x" + "a3".repeat(32);
export const policy = {
  canonicalToken: TOKEN, canonicalTokenRuntimeCodeHash: keccak256(TOKEN_CODE),
  tokenImplementationAddress: IMPLEMENTATION, tokenImplementationRuntimeCodeHash: keccak256(IMPL_CODE),
  tokenImplementationSlot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  tokenDomainSeparator: DOMAIN, maximumLogPageEvents: 1000, maximumSourceLagBlocks: 10, finalityBlockTimeSeconds: 2,
};
const bh = n => pad(toHex(n), { size: 32 });
export const listing = {
  deadlinePolicy: { settlementEvidenceSeconds: 900, releaseEvidenceSeconds: 900 },
  commitment: { payload: { canonicalToken: TOKEN, providerPayee: PAYEE, daskiCommissionReceiver: RECEIVER, commissionBps: BPS } },
  manifest: { payload: { splitterAddress: SPLITTER, splitterActivationBlockNumber: String(A), splitterActivationBlockHash: bh(A),
    splitterStartingTokenBalance: "0", splitterStartingReleaseSequence: "0", splitterRuntimeCodeHash: keccak256(SPLITTER_CODE),
    listingCommitmentHash: LCH, policyVersionHash: PVH, outcomeIdHash: OIH, listingEpoch: "1" } },
};
const ev = {
  used: parseAbiItem("event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)"),
  transfer: parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)"),
  released: parseAbiItem("event Released(bytes32 indexed outcomeIdHash,uint64 indexed listingEpoch,uint64 indexed releaseSequence,bytes32 policyVersionHash,bytes32 listingCommitmentHash,uint256 grossAmount,uint256 providerNetAmount,uint256 daskiCommissionAmount)"),
};
const u256 = v => encodeAbiParameters([{ type: "uint256" }], [v]);
const depLog = { blockNumber: toHex(D), blockHash: bh(D), transactionHash: TX, transactionIndex: "0x1", removed: false };
const relLog = { blockNumber: toHex(R), blockHash: bh(R), transactionHash: RTX, transactionIndex: "0x0", removed: false };
const depositTransfer = { ...depLog, address: TOKEN, topics: encodeEventTopics({ abi: [ev.transfer], args: { from: PAYER, to: SPLITTER } }), data: u256(GROSS), logIndex: "0x4" };
const releasedLog = { ...relLog, address: SPLITTER, logIndex: "0x2",
  topics: encodeEventTopics({ abi: [ev.released], args: { outcomeIdHash: OIH, listingEpoch: 1n, releaseSequence: 1n } }),
  data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [PVH, LCH, GROSS, NET, COMMISSION]) };
const receipts = {
  [TX]: { transactionHash: TX, transactionIndex: "0x1", blockHash: bh(D), blockNumber: toHex(D),
    logs: [{ ...depLog, address: TOKEN, topics: encodeEventTopics({ abi: [ev.used], args: { authorizer: PAYER, nonce: NONCE } }), data: "0x", logIndex: "0x3" }, depositTransfer] },
  [RTX]: { transactionHash: RTX, transactionIndex: "0x0", blockHash: bh(R), blockNumber: toHex(R),
    logs: [{ ...relLog, address: TOKEN, topics: encodeEventTopics({ abi: [ev.transfer], args: { from: SPLITTER, to: PAYEE } }), data: u256(NET), logIndex: "0x0" },
           { ...relLog, address: TOKEN, topics: encodeEventTopics({ abi: [ev.transfer], args: { from: SPLITTER, to: RECEIVER } }), data: u256(COMMISSION), logIndex: "0x1" },
           releasedLog] },
};
const sel = s => toFunctionSelector(s).slice(0, 10);
const calls = {
  [sel("DOMAIN_SEPARATOR()")]: DOMAIN,
  [sel("balanceOf(address)")]: u256(0n),
  [sel("releaseSequence()")]: u256(0n),
  [sel("canonicalToken()")]: pad(TOKEN, { size: 32 }),
  [sel("providerPayee()")]: pad(PAYEE, { size: 32 }),
  [sel("daskiCommissionReceiver()")]: pad(RECEIVER, { size: 32 }),
  [sel("commissionBps()")]: u256(BigInt(BPS)),
  [sel("listingCommitmentHash()")]: LCH,
  [sel("policyVersionHash()")]: PVH,
  [sel("outcomeIdHash()")]: OIH,
  [sel("listingEpoch()")]: u256(1n),
  [sel("authorizationState(address,bytes32)")]: u256(1n),
  ["0x1626ba7e"]: "0x1626ba7e" + "0".repeat(56),
};
function rpcAnswers(started) {
  const head = () => 40_000_000 + Math.floor((Date.now() - started) / 2000);
  const block = n => ({ number: toHex(n), hash: bh(n), parentHash: bh(n - 1), timestamp: toHex(Math.floor(Date.now() / 1000)), transactions: [],
    gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x1", miner: "0x" + "0".repeat(40), difficulty: "0x0", totalDifficulty: "0x0", size: "0x1",
    nonce: "0x0000000000000000", extraData: "0x", logsBloom: "0x" + "0".repeat(512), receiptsRoot: bh(0), sha3Uncles: bh(0), stateRoot: bh(0),
    transactionsRoot: bh(0), uncles: [], mixHash: bh(0) });
  const answer = ({ method, params }) => {
    switch (method) {
      case "eth_chainId": return "0x2105";
      case "eth_blockNumber": return toHex(head());
      case "eth_getBlockByNumber": return block(params?.[0]?.startsWith?.("0x") ? Number(params[0]) : head());
      case "eth_getTransactionReceipt": {
        const r = receipts[String(params[0]).toLowerCase()];
        return r ? { ...r, from: "0x" + "77".repeat(20), to: TOKEN, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
          contractAddress: null, status: "0x1", type: "0x2", logsBloom: "0x" + "0".repeat(512) } : null;
      }
      case "eth_getTransactionByHash": {
        const r = receipts[String(params[0]).toLowerCase()];
        return r ? { hash: r.transactionHash, blockHash: r.blockHash, blockNumber: r.blockNumber, transactionIndex: r.transactionIndex,
          from: "0x" + "77".repeat(20), to: TOKEN, nonce: "0x1", value: "0x0", input: "0x", gas: "0x1", gasPrice: "0x1", type: "0x0", chainId: "0x2105", v: "0x1b", r: "0x1", s: "0x1" } : null;
      }
      case "eth_getStorageAt": return pad(IMPLEMENTATION, { size: 32 });
      case "eth_getCode": {
        const a = String(params?.[0]).toLowerCase();
        return a === TOKEN ? TOKEN_CODE : a === IMPLEMENTATION ? IMPL_CODE : a === SPLITTER ? SPLITTER_CODE : a === PAYER ? "0x6001" :
          a === ORACLE ? ORACLE_CODE : "0x";
      }
      case "eth_call":
        // Sanctions screening aggregates isSanctioned through multicall3: nobody is sanctioned.
        if (String(params?.[0]?.to ?? "").toLowerCase() === MULTICALL3) {
          const { args } = decodeFunctionData({ abi: multicall3Abi, data: params[0].data });
          return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3",
            result: args[0].map(() => ({ success: true, returnData: encodeAbiParameters([{ type: "bool" }], [false]) })) });
        }
        return calls[String(params?.[0]?.data ?? "").slice(0, 10)] ?? "0x";
      case "eth_getLogs": {
        const f = params[0], from = Number(f.fromBlock), to = Number(f.toBlock);
        const t0 = Array.isArray(f.topics) ? f.topics[0] : null;
        const out = [];
        if (String(f.address).toLowerCase() === SPLITTER && t0 === releasedLog.topics[0] && from <= R && R <= to) out.push(releasedLog);
        if (String(f.address).toLowerCase() === TOKEN && t0 === depositTransfer.topics[0] && from <= D && D <= to) out.push(depositTransfer);
        return out;
      }
      default: return null;
    }
  };
  return answer;
}

// One JSON-RPC body in, one out: the requests are logged when they arrive,
// answered after the slowest one's latency.
function respond(started, log, latency) {
  const answer = rpcAnswers(started);
  return async body => {
    const parsed = JSON.parse(body);
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    const arrived = Date.now() - started;
    const wait = Math.max(...batch.map(c => latency(c.method)));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    for (const c of batch) log.push({ method: c.method, arrived, done: Date.now() - started, to: c.params?.[0]?.to });
    const out = batch.map(c => ({ jsonrpc: "2.0", id: c.id, result: answer(c) }));
    return JSON.stringify(Array.isArray(parsed) ? out : out[0]);
  };
}

/** The stub as an in-process fetch, for simulated time: stub it as the global fetch. */
export function fetchStub({ latency = () => 0 } = {}) {
  const started = Date.now(), log = [];
  const reply = respond(started, log, latency);
  const fetchFn = async (_url, init) => new Response(await reply(String(init.body)),
    { status: 200, headers: { "content-type": "application/json" } });
  return { fetchFn, log };
}

export function startStub({ latency = () => 0 } = {}) {
  const started = Date.now(), log = [];
  const reply = respond(started, log, latency);
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", async () => {
      const out = await reply(body);
      res.writeHead(200, { "content-type": "application/json" }).end(out);
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}/rpc`, log, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}
