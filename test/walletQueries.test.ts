import { describe, expect, it, vi } from "vitest";
import { baseSepolia } from "viem/chains";
import type { Pool } from "../src/db/pool.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import type { WalletAuthorizationTransport } from "../src/standardRail/types.js";
import { StandardWalletQueries } from "../src/standardRail/walletQueries.js";
import type { StandardWalletStore } from "../src/standardRail/walletStore.js";

describe("wallet reputation queries", () => {
  it("returns the buyer's on-chain value totals with their feedback counts", async () => {
    const consume = vi.fn(async () => undefined);
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getBuyerStats") return [4n, 3n, 1n];
      if (functionName === "totalPaidByPayer") return 12_000_000n;
      if (functionName === "refundedAmountByPayer") return 2_000_000n;
      throw new Error(`unexpected contract read: ${functionName}`);
    });
    const queries = new StandardWalletQueries(
      {} as Pool,
      { consume } as unknown as StandardWalletStore,
      {
        evidenceRpcUrls: ["https://rpc.example"],
        reputationContract: "0x1111111111111111111111111111111111111111",
      } as unknown as StandardRailConfig,
      baseSepolia,
    );
    Object.assign(queries as unknown as { chain: unknown }, {
      chain: { getBlock: vi.fn(async () => ({ number: 123n })), readContract },
    });

    await expect(queries.getReputation({
      payer: "0x2222222222222222222222222222222222222222",
      authorization: {} as WalletAuthorizationTransport,
    })).resolves.toEqual({
      eligibleTransactionCount: "4",
      confirmedCount: "3",
      notConfirmedCount: "1",
      totalPaid: "12000000",
      totalRefunded: "2000000",
      finalizedBlock: "123",
    });
    expect(consume).toHaveBeenCalledOnce();
    expect(readContract).toHaveBeenCalledTimes(3);
  });
});
