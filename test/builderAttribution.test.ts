import { afterEach, describe, expect, it, vi } from "vitest";
import {
  concatHex,
  createWalletClient,
  custom,
  keccak256,
  parseTransaction,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { BuilderAttribution } from "../src/standardRail/builderCode.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { StandardChainEvidence } from "../src/standardRail/evidence.js";
import type { FacilitatorNonceLock } from "../src/standardRail/facilitatorNonceLock.js";
import { encodeReputationOperation, type RevokeConfirmationIntent } from "../src/standardRail/reputationOperation.js";
import { StandardReputationWorker } from "../src/standardRail/reputationWorker.js";
import { GatewaySigner, localGatewaySigners, SignerRefused, type GatewaySigners } from "../src/standardRail/signer.js";
import { logger } from "../src/util/logger.js";

const KEY = `0x${"11".repeat(32)}` as Hex;
const account = privateKeyToAccount(KEY);
const CODE = "bc_0h3q8lqm";
const SUFFIX = "0x62635f30683371386c716d0b0080218021802180218021802180218021" as Hex;
const RELEASE_ALL = toFunctionSelector("function releaseAll() returns (uint256)");
const SPLITTER = "0x2222222222222222222222222222222222222222" as Address;

afterEach(() => { vi.restoreAllMocks(); });

/**
 * A remote (Privy) sender whose policy refuses any transaction carrying the
 * builder code, or every transaction; it records the data of each request.
 */
function remoteSender(refuse: "suffix" | "all" | "none") {
  const attribution = new BuilderAttribution(CODE);
  const requests: Hex[] = [];
  const inner = toAccount({
    address: account.address,
    signMessage: (args) => account.signMessage(args),
    signTypedData: (args) => account.signTypedData(args as never),
    signTransaction: async (transaction, options) => {
      requests.push(transaction.data ?? "0x");
      if (refuse === "all" || (refuse === "suffix" && attribution.carries(transaction.data))) {
        throw new SignerRefused("sender", "eth_signTransaction", "HTTP_403");
      }
      return account.signTransaction(transaction, options);
    },
  });
  const sender = new GatewaySigner("sender", "privy", account.address, inner, null, attribution);
  const signers: GatewaySigners = { ...localGatewaySigners(KEY), sender, attribution };
  return { signers, sender, requests, attribution };
}

describe("releaseAll", () => {
  function evidence(signers: GatewaySigners, wallet: unknown) {
    const nonceLock: FacilitatorNonceLock = { run: async <T>(work: () => Promise<T>) => work() };
    const instance = new StandardChainEvidence({
      evidenceRpcUrls: ["https://rpc-a.example"], signers, finalityConfirmations: 12,
    } as unknown as StandardRailConfig, baseSepolia, nonceLock);
    Object.assign(instance as unknown as Record<string, unknown>, {
      wallet,
      clients: [{ host: "rpc-a.example", client: { getTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 2n })) } }],
    });
    return (instance as unknown as { submitRelease(splitter: Address): Promise<Hex | null> }).submitRelease(SPLITTER);
  }

  it("carries the builder code when configured and nothing when unset", async () => {
    const writeContract = vi.fn(async () => `0x${"ee".repeat(32)}` as Hex);
    await evidence(localGatewaySigners(KEY, KEY, { builderCode: CODE }), { writeContract });
    await evidence(localGatewaySigners(KEY), { writeContract });
    expect(writeContract).toHaveBeenNthCalledWith(1, expect.objectContaining({ address: SPLITTER, functionName: "releaseAll", dataSuffix: SUFFIX }));
    expect(writeContract).toHaveBeenNthCalledWith(2, expect.objectContaining({ functionName: "releaseAll", dataSuffix: undefined }));
  });

  it("sends the same release without the code when the signer policy refuses it, and the role stays healthy", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const { signers, sender, requests, attribution } = remoteSender("suffix");
    const sent: Hex[] = [];
    const wallet = createWalletClient({ account: sender.account, chain: baseSepolia, transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        switch (method) {
          case "eth_chainId": return "0x14a34";
          case "eth_getTransactionCount": return "0x3";
          case "eth_estimateGas": return "0x186a0";
          case "eth_maxPriorityFeePerGas": return "0xf4240";
          case "eth_getBlockByNumber": return { baseFeePerGas: "0x3b9aca00", number: "0x1", timestamp: "0x1",
            hash: `0x${"ab".repeat(32)}`, transactions: [] };
          case "eth_sendRawTransaction": { const raw = (params as Hex[])[0]!; sent.push(raw); return keccak256(raw); }
          default: throw new Error(`unexpected ${method}`);
        }
      },
    }) });
    const hash = await evidence(signers, wallet);
    expect(requests).toEqual([concatHex([RELEASE_ALL, SUFFIX]), RELEASE_ALL]);
    expect(sent).toHaveLength(1);
    expect(hash).toBe(keccak256(sent[0]!));
    expect(parseTransaction(sent[0]!)).toMatchObject({ data: RELEASE_ALL, nonce: 3, to: SPLITTER });
    expect(sender.status()).toMatchObject({ status: "healthy", refusals: 0 });
    expect(attribution.current()).toBeNull();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("builder code refused by the signer policy"),
      { role: "sender", builderCode: CODE, reason: "HTTP_403" });
  });
});

describe("reputation relayer transactions", () => {
  const intent: RevokeConfirmationIntent = {
    operation: "revoke-confirmation", profileId: "eas-native-1.2.0",
    orderKey: `0x${"22".repeat(32)}`, orderId: "order-1", outcomeId: "mailbox", submissionsUsed: 1,
    request: { schema: `0x${"33".repeat(32)}`, data: { uid: `0x${"44".repeat(32)}`, value: "0" },
      signature: { v: 27, r: `0x${"55".repeat(32)}`, s: `0x${"66".repeat(32)}` },
      revoker: account.address, deadline: "1791000000" },
  };
  const operation = { operation_id: "operation-1", kind: "confirmation-v2", canonical_intent: intent,
    intent_hash: Buffer.alloc(32, 9), attempts: 0 };

  function relayer(signers: GatewaySigners) {
    const config = {
      signers, evidenceRpcUrls: ["https://rpc.example.test"], encryptionKey: Buffer.alloc(32, 1),
      easAddress: "0x4200000000000000000000000000000000000021", reputationConfirmationGasLimit: 500_000n,
      reputationMaxFeePerGasWei: 3_000_000_000n, reputationMaxPriorityFeePerGasWei: 1_000_000n,
    } as unknown as StandardRailConfig;
    const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const worker = new StandardReputationWorker({ query } as never, config, baseSepolia);
    const internal = worker as unknown as {
      highestObservedNonce(): Promise<number>;
      broadcastClient: { sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex> };
      persistPrepared(client: unknown, operation: unknown, encoded: unknown): Promise<{ transaction_hash: Hex }>;
      sendPersisted(operation: unknown, transaction: unknown): Promise<void>;
    };
    internal.highestObservedNonce = async () => 7;
    const inserts: unknown[][] = [];
    const client = { query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("INSERT INTO standard_reputation_transactions")) inserts.push(params);
      return { rowCount: 1, rows: [] };
    }) };
    const broadcasts: Hex[] = [];
    vi.spyOn(internal.broadcastClient, "sendRawTransaction").mockImplementation(async ({ serializedTransaction }) => {
      broadcasts.push(serializedTransaction);
      return keccak256(serializedTransaction);
    });
    const encoded = encodeReputationOperation(intent, config);
    /** Prepares, journals and sends one transaction; returns its calldata hash and broadcast bytes. */
    const run = async () => {
      const prepared = await internal.persistPrepared(client, operation, encoded);
      await internal.sendPersisted(operation, prepared);
      const insert = inserts.at(-1)!;
      return { calldataHash: `0x${(insert[7] as Buffer).toString("hex")}`, raw: broadcasts.at(-1), prepared, query };
    };
    return { run, encoded, query };
  }

  it("signs, journals and resends the code when configured; the calldata hash covers the signed bytes", async () => {
    const { run, encoded, query } = relayer(localGatewaySigners(KEY, KEY, { builderCode: CODE }));
    const { calldataHash, raw, prepared } = await run();
    const signed = concatHex([encoded.data, SUFFIX]);
    expect(raw).toBeDefined();
    expect(parseTransaction(raw!).data).toBe(signed);
    expect(calldataHash).toBe(keccak256(signed));
    expect(prepared.transaction_hash).toBe(keccak256(raw!));
    // The resend check accepted the journaled bytes: no review was parked.
    expect(query).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(["transaction_intent_mismatch"]));
  });

  it("signs the bare calldata when BASE_BUILDER_CODE is unset", async () => {
    const { run, encoded } = relayer(localGatewaySigners(KEY));
    const { calldataHash, raw } = await run();
    expect(parseTransaction(raw!).data).toBe(encoded.data);
    expect(calldataHash).toBe(keccak256(encoded.data));
  });

  it("journals the plain retry after a policy refusal of the code, and keeps the code off", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const remote = remoteSender("suffix");
    const { run, encoded } = relayer(remote.signers);
    const first = await run();
    expect(remote.requests).toEqual([concatHex([encoded.data, SUFFIX]), encoded.data]);
    expect(parseTransaction(first.raw!).data).toBe(encoded.data);
    expect(first.calldataHash).toBe(keccak256(encoded.data));
    expect(remote.sender.status()).toMatchObject({ status: "healthy", refusals: 0 });
    await run();
    expect(remote.requests.slice(2)).toEqual([encoded.data]);
  });

  it("surfaces a refusal of the plain retry as an ordinary signer refusal", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const remote = remoteSender("all");
    const { run, encoded } = relayer(remote.signers);
    await expect(run()).rejects.toMatchObject({ name: "SignerRefused", reason: "HTTP_403" });
    expect(remote.requests).toEqual([concatHex([encoded.data, SUFFIX]), encoded.data]);
    expect(remote.sender.status()).toMatchObject({ status: "unhealthy", reason: "signature_refused", refusals: 1 });
  });
});
