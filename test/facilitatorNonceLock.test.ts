import { describe, expect, it, vi } from "vitest";
import { baseSepolia } from "viem/chains";
import type { Pool } from "../src/db/pool.js";
import { StandardChainEvidence } from "../src/standardRail/evidence.js";
import {
  type FacilitatorNonceLock,
  PostgresFacilitatorNonceLock,
  unlockedFacilitatorNonceLock,
} from "../src/standardRail/facilitatorNonceLock.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { StandardReputationWorker } from "../src/standardRail/reputationWorker.js";

const privateKey = `0x${"01".repeat(32)}` as const;
const address = "0x1111111111111111111111111111111111111111" as const;
const hash = (digit: string) => `0x${digit.repeat(64)}` as const;

describe("facilitator nonce coordination", () => {
  it("uses one address-scoped PostgreSQL lock and releases it after failure", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const lock = new PostgresFacilitatorNonceLock(pool, 84_532, address);

    await expect(lock.run(async () => {
      throw new Error("work failed");
    })).rejects.toThrow("work failed");

    expect(queries.map(({ values }) => values[0])).toEqual([
      "standard:facilitator-nonce:84532:0x1111111111111111111111111111111111111111",
      "standard:facilitator-nonce:84532:0x1111111111111111111111111111111111111111",
    ]);
    expect(queries[0]!.sql).toContain("pg_advisory_lock");
    expect(queries[1]!.sql).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("submits splitter releases while holding the shared nonce lock", async () => {
    const events: string[] = [];
    const lockUsed = vi.fn();
    const nonceLock: FacilitatorNonceLock = {
      async run<T>(work: () => Promise<T>): Promise<T> {
        lockUsed();
        events.push("lock");
        try {
          return await work();
        } finally {
          events.push("unlock");
        }
      },
    };
    const evidence = new StandardChainEvidence({
      evidenceRpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
      releasePrivateKey: privateKey,
      finalityConfirmations: 12,
    } as unknown as StandardRailConfig, baseSepolia, nonceLock);
    Object.assign(evidence as unknown as { wallet: unknown; clients: unknown[] }, {
      wallet: {
        writeContract: vi.fn(async () => {
          events.push("send");
          return hash("a");
        }),
      },
      clients: [{
        host: "rpc-a.example",
        client: {
          waitForTransactionReceipt: vi.fn(async () => {
            events.push("finalized");
          }),
        },
      }],
    });

    await expect((evidence as unknown as {
      submitRelease(splitter: typeof address): Promise<string>;
    }).submitRelease(address)).resolves.toBe(hash("a"));
    expect(events).toEqual(["lock", "send", "finalized", "unlock"]);
    expect(lockUsed).toHaveBeenCalledOnce();
  });

  it("uses the highest latest-or-pending nonce from the selected RPC", async () => {
    const worker = new StandardReputationWorker({} as Pool, {
      reputationRelayerPrivateKey: privateKey,
      evidenceRpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
    } as unknown as StandardRailConfig, baseSepolia, unlockedFacilitatorNonceLock);
    const fallback = { getTransactionCount: vi.fn(async () => 13) };
    Object.assign(worker as unknown as { evidenceClients: unknown[] }, {
      evidenceClients: [
        {
          host: "rpc-a.example",
          client: {
            getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) =>
              blockTag === "latest" ? 13 : 11),
          },
        },
        {
          host: "rpc-b.example",
          client: fallback,
        },
      ],
    });

    await expect((worker as unknown as {
      highestObservedNonce(): Promise<number>;
    }).highestObservedNonce()).resolves.toBe(13);
    expect(fallback.getTransactionCount).not.toHaveBeenCalled();
  });

  it("does not broadcast a persisted raw transaction after its nonce is occupied", async () => {
    let locked = false;
    const lockUsed = vi.fn();
    const nonceLock: FacilitatorNonceLock = {
      async run<T>(work: () => Promise<T>): Promise<T> {
        lockUsed();
        locked = true;
        try {
          return await work();
        } finally {
          locked = false;
        }
      },
    };
    const worker = new StandardReputationWorker({} as Pool, {
      reputationRelayerPrivateKey: privateKey,
      evidenceRpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
    } as unknown as StandardRailConfig, baseSepolia, nonceLock);
    const conflict = vi.fn(async () => {
      expect(locked).toBe(true);
    });
    const send = vi.fn();
    Object.assign(worker as unknown as Record<string, unknown>, {
      transactionVisible: vi.fn(async () => false),
      highestObservedNonce: vi.fn(async () => 13),
      resolveNonceConflict: conflict,
      sendPersisted: send,
    });

    await (worker as unknown as {
      broadcastPersisted(operation: unknown, transaction: unknown): Promise<void>;
    }).broadcastPersisted(
      { operation_id: "operation-1" },
      { nonce: "12", transaction_hash: hash("b") },
    );

    expect(lockUsed).toHaveBeenCalledOnce();
    expect(conflict).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
});
