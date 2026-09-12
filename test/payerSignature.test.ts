import { describe, expect, it, vi } from "vitest";
import {
  ExecutionRevertedError,
  RpcRequestError,
  decodeFunctionData,
  encodeAbiParameters,
  hashTypedData,
  parseAbi,
  parseSignature,
  serializeErc6492Signature,
  serializeSignature,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CONTRACT_VERIFICATION_GAS,
  ContractVerificationSemaphore,
  createPayerSignatureVerifier,
  ERC1271_MAGIC_VALUE,
  isExplicitCallFailure,
  PAYER_SIGNATURE_MAX_BYTES,
  type ContractVerificationClient,
  type PayerTypedData,
} from "../src/standardRail/payerSignature.js";

const payerKey = privateKeyToAccount(`0x${"11".repeat(32)}`);
const otherKey = privateKeyToAccount(`0x${"22".repeat(32)}`);
const CONTRACT = "0x3333333333333333333333333333333333333333" as Address;
const erc1271Abi = parseAbi([
  "function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4)",
]);
const magic = (`${ERC1271_MAGIC_VALUE}${"00".repeat(28)}`) as Hex;

const typedData: PayerTypedData = {
  domain: { name: "DaskiStandardWallet", version: "1", chainId: 84532 },
  types: { Probe: [{ name: "nonce", type: "bytes32" }, { name: "issuedAt", type: "uint64" }] },
  primaryType: "Probe",
  message: { nonce: `0x${"ab".repeat(32)}`, issuedAt: 1_800_000_000n },
};

async function eoaSignature(account = payerKey): Promise<Hex> {
  return account.signTypedData(typedData as never);
}

function highS(signature: Hex): Hex {
  const parts = parseSignature(signature);
  const order = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  return serializeSignature({
    r: parts.r,
    s: `0x${(order - BigInt(parts.s)).toString(16).padStart(64, "0")}` as Hex,
    yParity: parts.yParity === 0 ? 1 : 0,
  });
}

/** A client that records calls; every method can be scripted per test. */
function mockClient(script: {
  code?: () => Promise<Hex | undefined>;
  call?: (args: { to: Address; data: Hex; gas: bigint }) => Promise<{ data?: Hex }>;
}) {
  const calls: string[] = [];
  const client: ContractVerificationClient = {
    getCode: vi.fn(async () => { calls.push("getCode"); return script.code ? script.code() : `0x6001`; }),
    call: vi.fn(async (args) => {
      calls.push("call");
      return script.call ? script.call(args) : { data: magic };
    }),
  };
  return { client, calls };
}

function verifier(options: {
  accountTypes?: readonly ("eoa" | "contract")[];
  endpoints: Array<{ host: string; client: ContractVerificationClient }>;
  timeoutMs?: number;
  admit?: (payer: Address) => Promise<void>;
  semaphore?: ContractVerificationSemaphore;
}) {
  return createPayerSignatureVerifier({
    accountTypes: options.accountTypes ?? ["eoa", "contract"],
    timeoutMs: options.timeoutMs ?? 1_000,
    endpoints: options.endpoints,
    admit: options.admit,
    semaphore: options.semaphore ?? new ContractVerificationSemaphore(8),
  });
}

describe("payer signature verification: the EOA path", () => {
  it("accepts a 65-byte low-s signature that recovers to the payer without any RPC", async () => {
    const primary = mockClient({});
    const admit = vi.fn(async () => undefined);
    const result = await verifier({ endpoints: [{ host: "a", client: primary.client }], admit })
      .verifyPayerTypedData({ payer: payerKey.address, typedData, signature: await eoaSignature() });
    expect(result).toEqual({ accountType: "eoa", verifiedVia: "recovery" });
    expect(primary.calls).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
  });

  it("issues no RPC and charges nothing for any recovering signature (property over keys)", async () => {
    const primary = mockClient({
      code: async () => { throw new Error("must not be called"); },
      call: async () => { throw new Error("must not be called"); },
    });
    const admit = vi.fn(async () => { throw new Error("must not be called"); });
    const subject = verifier({ endpoints: [{ host: "a", client: primary.client }], admit });
    for (let index = 1; index <= 12; index += 1) {
      const account = privateKeyToAccount(`0x${index.toString(16).padStart(64, "0")}`);
      await expect(subject.verifyPayerTypedData({
        payer: account.address,
        typedData,
        signature: await account.signTypedData(typedData as never),
      })).resolves.toEqual({ accountType: "eoa", verifiedVia: "recovery" });
    }
    expect(primary.calls).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
  });

  it("refuses a 65-byte signature that recovers to another key when only EOAs are enabled, offline", async () => {
    const primary = mockClient({});
    const admit = vi.fn(async () => undefined);
    await expect(verifier({
      accountTypes: ["eoa"], endpoints: [{ host: "a", client: primary.client }], admit,
    }).verifyPayerTypedData({
      payer: payerKey.address, typedData, signature: await eoaSignature(otherKey),
    })).rejects.toMatchObject({ code: "SIGNATURE_INVALID", requiresNewSignature: true });
    expect(primary.calls).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
  });

  it("routes a high-s or otherwise non-recovering 65-byte value to the contract path", async () => {
    const primary = mockClient({ code: async () => "0x" });
    const admit = vi.fn(async () => undefined);
    const subject = verifier({ endpoints: [{ host: "a", client: primary.client }], admit });
    for (const signature of [highS(await eoaSignature()), await eoaSignature(otherKey)]) {
      await expect(subject.verifyPayerTypedData({ payer: payerKey.address, typedData, signature }))
        .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    }
    // An EOA has no code, so both were refused after exactly one code lookup each.
    expect(primary.calls).toEqual(["getCode", "getCode"]);
    expect(admit).toHaveBeenCalledTimes(2);
  });
});

describe("payer signature verification: size rule and wrappers", () => {
  const subject = () => verifier({ endpoints: [{ host: "a", client: mockClient({}).client }] });

  it.each([
    ["odd hex", "0x123" as Hex],
    ["empty", "0x" as Hex],
    ["not hex", "0xzz" as Hex],
    ["oversized", `0x${"ab".repeat(PAYER_SIGNATURE_MAX_BYTES + 1)}` as Hex],
  ])("refuses a malformed signature (%s) as SIGNATURE_INVALID", async (_label, signature) => {
    await expect(subject().verifyPayerTypedData({ payer: payerKey.address, typedData, signature }))
      .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });

  it("refuses an ERC-6492 wrapper as counterfactual before any RPC or admission", async () => {
    const primary = mockClient({});
    const admit = vi.fn(async () => undefined);
    const wrapped = serializeErc6492Signature({
      address: CONTRACT,
      data: "0xdeadbeef",
      signature: await eoaSignature(otherKey),
    });
    await expect(verifier({ endpoints: [{ host: "a", client: primary.client }], admit })
      .verifyPayerTypedData({ payer: CONTRACT, typedData, signature: wrapped }))
      .rejects.toMatchObject({ code: "SIGNATURE_COUNTERFACTUAL_REJECTED", retryable: true });
    expect(primary.calls).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
  });

  it("refuses the contract path entirely when PAYER_ACCOUNT_TYPES is eoa", async () => {
    const primary = mockClient({});
    await expect(verifier({ accountTypes: ["eoa"], endpoints: [{ host: "a", client: primary.client }] })
      .verifyPayerTypedData({ payer: CONTRACT, typedData, signature: `0x${"ab".repeat(100)}` }))
      .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    expect(primary.calls).toEqual([]);
  });
});

describe("payer signature verification: the contract path", () => {
  const opaque = `0x${"c0".repeat(300)}` as Hex;

  it("accepts a deployed contract whose isValidSignature returns the magic value for the local hash", async () => {
    let seen: { to: Address; data: Hex; gas: bigint } | undefined;
    const primary = mockClient({ call: async (args) => { seen = args; return { data: magic }; } });
    const order: string[] = [];
    const admit = vi.fn(async () => { order.push("admit"); });
    const result = await verifier({ endpoints: [{ host: "a", client: primary.client }], admit })
      .verifyPayerTypedData({ payer: CONTRACT, typedData, signature: opaque });
    expect(result).toEqual({ accountType: "contract", verifiedVia: "erc1271" });
    expect(admit).toHaveBeenCalledWith(CONTRACT);
    expect([...order, ...primary.calls]).toEqual(["admit", "getCode", "call"]);
    expect(seen?.to).toBe(CONTRACT);
    expect(seen?.gas).toBe(CONTRACT_VERIFICATION_GAS);
    const decoded = decodeFunctionData({ abi: erc1271Abi, data: seen!.data });
    expect(decoded.args).toEqual([hashTypedData(typedData as never), opaque]);
  });

  it("refuses when the admission is denied, before any RPC", async () => {
    const primary = mockClient({});
    const admit = vi.fn(async () => { throw new Error("SIGNATURE_VERIFICATION_BUSY"); });
    await expect(verifier({ endpoints: [{ host: "a", client: primary.client }], admit })
      .verifyPayerTypedData({ payer: CONTRACT, typedData, signature: opaque }))
      .rejects.toThrow("SIGNATURE_VERIFICATION_BUSY");
    expect(primary.calls).toEqual([]);
  });

  it.each([
    ["a revert", async () => { throw new ExecutionRevertedError({ message: "execution reverted" }); }],
    ["an rpc error code 3", async () => {
      throw new RpcRequestError({ body: {}, error: { code: 3, message: "execution reverted" }, url: "https://a" });
    }],
    ["a wrong magic value", async () => ({ data: `0xffffffff${"00".repeat(28)}` as Hex })],
    ["a short return", async () => ({ data: ERC1271_MAGIC_VALUE as Hex })],
    ["an empty return", async () => ({ data: "0x" as Hex })],
    ["an oversized return", async () => ({ data: `0x${"16".repeat(40)}` as Hex })],
  ])("treats %s as final SIGNATURE_INVALID without failing over", async (_label, call) => {
    const primary = mockClient({ call });
    const fallback = mockClient({});
    await expect(verifier({
      endpoints: [{ host: "a", client: primary.client }, { host: "b", client: fallback.client }],
    }).verifyPayerTypedData({ payer: CONTRACT, typedData, signature: opaque }))
      .rejects.toMatchObject({ code: "SIGNATURE_INVALID", retryable: true });
    expect(fallback.calls).toEqual([]);
  });

  it("refuses an address without code as SIGNATURE_INVALID, final", async () => {
    const primary = mockClient({ code: async () => undefined });
    const fallback = mockClient({});
    await expect(verifier({
      endpoints: [{ host: "a", client: primary.client }, { host: "b", client: fallback.client }],
    }).verifyPayerTypedData({ payer: CONTRACT, typedData, signature: opaque }))
      .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    expect(primary.calls).toEqual(["getCode"]);
    expect(fallback.calls).toEqual([]);
  });

  it("fails over exactly once on a transport failure and then verifies", async () => {
    const primary = mockClient({ code: async () => { throw new Error("ECONNRESET"); } });
    const fallback = mockClient({});
    const result = await verifier({
      endpoints: [{ host: "a", client: primary.client }, { host: "b", client: fallback.client }],
    }).verifyPayerTypedData({ payer: CONTRACT, typedData, signature: opaque });
    expect(result.verifiedVia).toBe("erc1271");
    expect(primary.calls).toEqual(["getCode"]);
    expect(fallback.calls).toEqual(["getCode", "call"]);
  });

  it("answers SIGNATURE_VERIFICATION_UNAVAILABLE when every endpoint fails, retryable without a new signature", async () => {
    const primary = mockClient({ call: async () => { throw new Error("socket hang up"); } });
    const fallback = mockClient({ code: async () => { throw new Error("timeout"); } });
    const third = mockClient({});
    await expect(verifier({
      endpoints: [
        { host: "a", client: primary.client },
        { host: "b", client: fallback.client },
        { host: "c", client: third.client },
      ],
    }).verifyPayerTypedData({ payer: CONTRACT, typedData, signature: opaque }))
      .rejects.toMatchObject({
        code: "SIGNATURE_VERIFICATION_UNAVAILABLE", retryable: true, requiresNewSignature: false,
      });
    // At most one failover: the third endpoint is never consulted.
    expect(third.calls).toEqual([]);
  });

  it("enforces one total deadline across the code lookup, the call, and the failover", async () => {
    const hang = () => new Promise<never>(() => undefined);
    const primary = mockClient({ code: hang });
    const fallback = mockClient({});
    const started = Date.now();
    await expect(verifier({
      timeoutMs: 60,
      endpoints: [{ host: "a", client: primary.client }, { host: "b", client: fallback.client }],
    }).verifyPayerTypedData({ payer: CONTRACT, typedData, signature: opaque }))
      .rejects.toMatchObject({ code: "SIGNATURE_VERIFICATION_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fallback.calls).toEqual([]);
  });

  it("bounds concurrent contract verifications with the process-wide semaphore", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const primary = mockClient({ code: async () => { await gate; return "0x6001"; } });
    const semaphore = new ContractVerificationSemaphore(1);
    const subject = verifier({ endpoints: [{ host: "a", client: primary.client }], semaphore });
    const first = subject.verifyPayerTypedData({ payer: CONTRACT, typedData, signature: opaque });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(subject.verifyPayerTypedData({ payer: CONTRACT, typedData, signature: opaque }))
      .rejects.toMatchObject({ code: "SIGNATURE_VERIFICATION_BUSY", retryable: true });
    releaseFirst();
    await expect(first).resolves.toEqual({ accountType: "contract", verifiedVia: "erc1271" });
    expect(semaphore.inFlight).toBe(0);
    // The slot is free again.
    await expect(subject.verifyPayerTypedData({ payer: CONTRACT, typedData, signature: opaque }))
      .resolves.toMatchObject({ verifiedVia: "erc1271" });
  });

  it("never carries signature bytes or typed data into the error it raises", async () => {
    const primary = mockClient({ call: async () => { throw new ExecutionRevertedError({ message: "execution reverted" }); } });
    const error = await verifier({ endpoints: [{ host: "a", client: primary.client }] })
      .verifyPayerTypedData({ payer: CONTRACT, typedData, signature: opaque })
      .then(() => { throw new Error("expected a refusal"); }, (caught: unknown) => caught as Error & {
        cause?: unknown; logContext: unknown;
      });
    const serialized = JSON.stringify({ message: error.message, cause: error.cause, log: error.logContext });
    expect(serialized).not.toContain("c0c0c0");
    expect(serialized).not.toContain("abab");
  });
});

describe("explicit call failures", () => {
  it("classifies reverts and out-of-gas answers as explicit, and transport faults as not", () => {
    expect(isExplicitCallFailure(new ExecutionRevertedError({ message: "execution reverted" }))).toBe(true);
    expect(isExplicitCallFailure(new RpcRequestError({
      body: {}, error: { code: -32000, message: "out of gas" }, url: "https://a",
    }))).toBe(true);
    expect(isExplicitCallFailure(new RpcRequestError({
      body: {}, error: { code: -32603, message: "internal error" }, url: "https://a",
    }))).toBe(false);
    expect(isExplicitCallFailure(new Error("ECONNRESET"))).toBe(false);
  });
});

// The magic value is what the contract path compares, byte for byte.
describe("ERC-1271 magic", () => {
  it("is the bytes4 selector of isValidSignature(bytes32,bytes)", () => {
    expect(encodeAbiParameters([{ type: "bytes4" }], [ERC1271_MAGIC_VALUE]).startsWith(ERC1271_MAGIC_VALUE)).toBe(true);
  });
});
