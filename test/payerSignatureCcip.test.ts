import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeErrorResult, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import {
  ContractVerificationSemaphore,
  createContractVerificationEndpoint,
  createPayerSignatureVerifier,
  ERC1271_MAGIC_VALUE,
  type PayerTypedData,
} from "../src/standardRail/payerSignature.js";

/// The contract path never follows an EIP-3668 OffchainLookup: a payer
/// contract that reverts with one names URLs the gateway must not fetch and
/// a callback the gateway must not honour. The endpoint the service builds
/// talks to the node through raw eth_getCode / eth_call, so the revert is a
/// final SIGNATURE_INVALID and no outbound request leaves the process.

const PAYER = "0x3333333333333333333333333333333333333333" as Address;
const ATTACKER_URL = "http://169.254.169.254/latest/meta-data/{sender}/{data}";
const magic = (`${ERC1271_MAGIC_VALUE}${"00".repeat(28)}`) as Hex;
const typedData: PayerTypedData = {
  domain: { name: "DaskiStandardWallet", version: "1", chainId: 84532 },
  types: { Probe: [{ name: "nonce", type: "bytes32" }] },
  primaryType: "Probe",
  message: { nonce: `0x${"ab".repeat(32)}` },
};

const offchainLookupAbi = [{
  name: "OffchainLookup", type: "error",
  inputs: [
    { name: "sender", type: "address" }, { name: "urls", type: "string[]" },
    { name: "callData", type: "bytes" }, { name: "callbackFunction", type: "bytes4" },
    { name: "extraData", type: "bytes" },
  ],
}] as const;

/** A JSON-RPC node whose payer contract answers isValidSignature as scripted. */
function rpcFetch(log: string[], answer: "offchain-lookup" | "magic"): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    log.push(body.method);
    const reply = (payload: Record<string, unknown>) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    if (body.method === "eth_getCode") return reply({ result: "0x6001" });
    if (body.method === "eth_call") {
      const call = body.params[0] as { data: Hex };
      if (answer === "offchain-lookup" && call.data.startsWith("0x1626ba7e")) {
        const data = encodeErrorResult({
          abi: offchainLookupAbi, errorName: "OffchainLookup",
          args: [PAYER, [ATTACKER_URL], "0x1234", "0xdeadbeef", "0x"],
        });
        return reply({ error: { code: 3, message: "execution reverted", data } });
      }
      return reply({ result: magic });
    }
    return reply({ error: { code: -32601, message: "method not found" } });
  };
}

function verifier(log: string[], answer: "offchain-lookup" | "magic") {
  return createPayerSignatureVerifier({
    accountTypes: ["eoa", "contract"],
    timeoutMs: 2_000,
    endpoints: [createContractVerificationEndpoint({
      url: "https://rpc.example", chain: baseSepolia, timeoutMs: 2_000, fetchFn: rpcFetch(log, answer),
    })],
    semaphore: new ContractVerificationSemaphore(8),
  });
}

describe("contract path against an EIP-3668 OffchainLookup revert", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("refuses the signature as a final SIGNATURE_INVALID and fetches nothing", async () => {
    const outbound: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      outbound.push(String(input));
      return new Response(JSON.stringify({ data: "0x4242" }), { status: 200 });
    }) as typeof fetch;
    const log: string[] = [];
    await expect(verifier(log, "offchain-lookup").verifyPayerTypedData({
      payer: PAYER, typedData, signature: `0x${"c0".repeat(100)}`,
    })).rejects.toMatchObject({ code: "SIGNATURE_INVALID", retryable: true });
    expect(outbound).toEqual([]);
    expect(log).toEqual(["eth_getCode", "eth_call"]);
  });

  it("still verifies a contract that answers the magic value through the raw call", async () => {
    const log: string[] = [];
    await expect(verifier(log, "magic").verifyPayerTypedData({
      payer: PAYER, typedData, signature: `0x${"c0".repeat(100)}`,
    })).resolves.toEqual({ accountType: "contract", verifiedVia: "erc1271" });
    expect(log).toEqual(["eth_getCode", "eth_call"]);
  });
});
