import { TransactionReceiptNotFoundError, keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import { baseSepolia } from "viem/chains";
import type { Pool } from "../src/db/pool.js";
import { StandardChainEvidence } from "../src/standardRail/evidence.js";
import { unlockedFacilitatorNonceLock } from "../src/standardRail/facilitatorNonceLock.js";
import { withFederationPermit } from "../src/standardRail/federationPermit.js";
import {
  refreshReputationPermit,
  reputationPermitDeadline,
} from "../src/standardRail/reputationOrders.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import type { RegisterIntent } from "../src/standardRail/reputationOperation.js";
import { StandardReputationWorker } from "../src/standardRail/reputationWorker.js";
import type { ProviderIdentitySnapshotV1 } from "../src/standardRail/types.js";

const privateKey = `0x${"01".repeat(32)}` as const;
const hash = (digit: string) => `0x${digit.repeat(64)}` as const;

describe("standard rail hardened mechanisms", () => {
  it("acquires provider then global slots only from the isolated permit pool", async () => {
    const acquired: string[] = [];
    const client = {
      async query(sql: string, values: unknown[]) {
        if (sql.includes("pg_try_advisory_lock")) {
          acquired.push(String(values[0]));
          return { rows: [{ acquired: true }] };
        }
        return { rows: [{ pg_advisory_unlock: true }] };
      },
      release: vi.fn(),
    };
    const permitPool = { connect: async () => client } as unknown as Pool;
    await expect(withFederationPermit({
      pool: permitPool,
      providerAgentId: "provider-1",
      providerLimit: 4,
      globalLimit: 40,
      timeoutMs: 100,
      work: async () => "complete",
    })).resolves.toBe("complete");
    expect(acquired).toEqual([
      "standard:federation:provider:provider-1:0",
      "standard:federation:global:0",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("refreshes an expiring reputation permit without changing its facts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_000_000_000 * 1_000));
    try {
      const intent = {
        operation: "register-order",
        permit: {
          orderKey: hash("1"), authorizationKey: hash("2"), providerAgentId: "1",
          serviceId: hash("3"), payer: "0x1111111111111111111111111111111111111111",
          providerOwner: "0x2222222222222222222222222222222222222222",
          providerAgentWallet: "0x3333333333333333333333333333333333333333",
          providerPayee: "0x4444444444444444444444444444444444444444",
          identityRegistry: "0x5555555555555555555555555555555555555555",
          providerRegistry: "0x6666666666666666666666666666666666666666",
          serviceRegistry: "0x7777777777777777777777777777777777777777",
          blockNumber: "10", blockHash: hash("4"),
          canonicalToken: "0x8888888888888888888888888888888888888888",
          grossAmount: "1000000", paidAt: "1999999000",
          providerIdentitySnapshotHash: hash("5"), listingManifestHash: hash("6"),
          releaseEvidenceHash: hash("7"), reputationEligible: true,
          validBefore: "2000000010",
        },
        signature: `0x${"00".repeat(65)}`,
      } as RegisterIntent;
      const config = {
        reputationPermitTtlSeconds: 900,
        reputationOrderPrivateKey: privateKey,
        reputationContract: "0x9999999999999999999999999999999999999999",
      } as unknown as StandardRailConfig;
      const refreshed = await refreshReputationPermit(intent, config, 84_532);
      if (refreshed.operation !== "register-order") throw new Error("expected a register-order intent");
      expect(reputationPermitDeadline(refreshed)).toBe(2_000_000_900n);
      expect(refreshed).toMatchObject({
        operation: "register-order",
        permit: { orderKey: hash("1"), grossAmount: "1000000" },
      });
      expect(refreshed.signature).toMatch(/^0x[0-9a-f]{130}$/);
      expect(refreshed.signature).not.toBe(intent.signature);
    } finally {
      vi.useRealTimers();
    }
  });

  it("revalidates provider identity at current finalized state and rejects rotation", async () => {
    const owner = "0x1111111111111111111111111111111111111111";
    const wallet = "0x2222222222222222222222222222222222222222";
    const originalPayee = "0x3333333333333333333333333333333333333333";
    let payee = originalPayee;
    const getBlock = vi.fn(async () => ({ number: 123n }));
    const client = {
      getBlock,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "ownerOf") return owner;
        if (functionName === "getAgentWallet") return wallet;
        if (functionName === "getProvider") return { agentId: 1n, isActive: true };
        return [1n, true, owner, wallet, payee];
      }),
    };
    const config = {
      evidenceRpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
      releasePrivateKey: privateKey,
    } as unknown as StandardRailConfig;
    const evidence = new StandardChainEvidence(config, baseSepolia, unlockedFacilitatorNonceLock);
    Object.assign(evidence as unknown as { clients: unknown[] }, {
      clients: [{ host: "rpc-a.example", client }, { host: "rpc-b.example", client }],
    });
    const snapshot = {
      providerAgentId: "1", serviceId: hash("8"),
      identityRegistry: "0x4444444444444444444444444444444444444444",
      providerRegistry: "0x5555555555555555555555555555555555555555",
      serviceRegistry: "0x6666666666666666666666666666666666666666",
      providerOwner: owner, providerAgentWallet: wallet, providerPayee: originalPayee,
      blockNumber: "10", blockHash: hash("9"),
    } as ProviderIdentitySnapshotV1;
    await expect(evidence.revalidateProviderIdentitySnapshot(snapshot)).resolves.toBeUndefined();
    expect(getBlock).toHaveBeenCalledWith({ blockTag: "finalized" });
    payee = "0x7777777777777777777777777777777777777777";
    await expect(evidence.revalidateProviderIdentitySnapshot(snapshot))
      .rejects.toThrow("Provider identity changed after listing admission");
  });

  it("serializes finalized identity reads across evidence sources", async () => {
    const owner = "0x1111111111111111111111111111111111111111";
    const wallet = "0x2222222222222222222222222222222222222222";
    const payee = "0x3333333333333333333333333333333333333333";
    let active = 0;
    let maximumActive = 0;
    const tracked = async <T>(value: T): Promise<T> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return value;
    };
    const client = {
      getBlock: () => tracked({ hash: hash("9") }),
      readContract: ({ functionName }: { functionName: string }) => {
        if (functionName === "ownerOf") return tracked(owner);
        if (functionName === "getAgentWallet") return tracked(wallet);
        if (functionName === "getProvider") return tracked({ agentId: 1n, isActive: true });
        return tracked([1n, true, owner, wallet, payee] as const);
      },
    };
    const evidence = new StandardChainEvidence({
      evidenceRpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
      releasePrivateKey: privateKey,
    } as unknown as StandardRailConfig, baseSepolia, unlockedFacilitatorNonceLock);
    Object.assign(evidence as unknown as { clients: unknown[] }, {
      clients: [{ host: "rpc-a.example", client }, { host: "rpc-b.example", client }],
    });
    await expect(evidence.verifyProviderIdentitySnapshot({
      providerAgentId: "1", serviceId: hash("8"),
      identityRegistry: "0x4444444444444444444444444444444444444444",
      providerRegistry: "0x5555555555555555555555555555555555555555",
      serviceRegistry: "0x6666666666666666666666666666666666666666",
      providerOwner: owner, providerAgentWallet: wallet, providerPayee: payee,
      blockNumber: "10", blockHash: hash("9"),
    })).resolves.toBeUndefined();
    expect(maximumActive).toBe(1);
  });

  it("aggregates sanctions screening into one pinned read through the selected RPC", async () => {
    const oracleCode = "0x6001600101" as const;
    const multicall = vi.fn(async ({ contracts, allowFailure, blockNumber }: {
      contracts: Array<{ functionName: string; args: readonly unknown[] }>;
      allowFailure?: boolean;
      blockNumber?: bigint;
    }) => {
      expect(allowFailure).toBe(false);
      expect(blockNumber).toBe(123n);
      expect(contracts.every(({ functionName }) => functionName === "isSanctioned")).toBe(true);
      return contracts.map(() => false);
    });
    const client = {
      getBlockNumber: vi.fn(async () => 123n),
      getBytecode: vi.fn(async () => oracleCode),
      multicall,
    };
    const evidence = new StandardChainEvidence({
      evidenceRpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
      releasePrivateKey: privateKey,
      manifest: { chainEvidencePolicy: { payload: { maximumSourceLagBlocks: 4 } } },
    } as unknown as StandardRailConfig, baseSepolia, unlockedFacilitatorNonceLock);
    Object.assign(evidence as unknown as { clients: unknown[] }, {
      clients: [{ host: "rpc-a.example", client }, { host: "rpc-b.example", client }],
    });
    await expect(evidence.assertNotSanctioned(
      "0x1111111111111111111111111111111111111111",
      keccak256(oracleCode),
      [
        "0x2222222222222222222222222222222222222222",
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ],
    )).resolves.toBeUndefined();
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall.mock.calls[0]![0].contracts).toHaveLength(2);

    multicall.mockImplementation(async ({ contracts }) => contracts.map((_, index) => index === 1));
    await expect(evidence.assertNotSanctioned(
      "0x1111111111111111111111111111111111111111",
      keccak256(oracleCode),
      [
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ],
    )).rejects.toThrow("SANCTIONS_ADDRESS_REJECTED");
  });

  it("resumes a persisted reputation transaction after restart without preparing another", async () => {
    const transactionHash = hash("a");
    let operationSelected = false;
    const statements: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        statements.push(sql);
        if (sql.includes("FROM standard_reputation_operations") && sql.includes("kind=$1")) {
          if (!operationSelected && values?.[0] === "register") {
            operationSelected = true;
            return { rows: [{
              operation_id: "operation-1", order_id: "order-1", kind: "register",
              intent_hash: Buffer.from("11".repeat(32), "hex"), canonical_intent: {}, attempts: 0,
            }] };
          }
          return { rows: [] };
        }
        if (sql.includes("FROM standard_reputation_transactions")) {
          return { rows: [{
            transaction_id: "transaction-1", nonce: "7",
            encrypted_raw_transaction: Buffer.alloc(1), transaction_hash: transactionHash,
            state: "broadcast",
          }] };
        }
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as Pool;
    const worker = new StandardReputationWorker(pool, {
      reputationRelayerPrivateKey: privateKey,
      evidenceRpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
    } as unknown as StandardRailConfig, baseSepolia);
    Object.assign(worker as unknown as { evidenceClients: unknown[] }, {
      evidenceClients: [{
        host: "rpc-a.example",
        client: {
          getTransactionReceipt: vi.fn(async () => {
            throw new TransactionReceiptNotFoundError({ hash: transactionHash });
          }),
          getTransaction: vi.fn(async () => ({ hash: transactionHash })),
        },
      }],
    });

    await (worker as unknown as { runBatch(): Promise<void> }).runBatch();

    expect(statements.some((sql) => sql.includes("INSERT INTO standard_reputation_transactions")))
      .toBe(false);
    expect(statements.some((sql) => sql.includes("SET state='broadcast',next_attempt_at")))
      .toBe(true);
  });
});
