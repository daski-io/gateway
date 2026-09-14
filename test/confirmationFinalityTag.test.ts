import { describe, expect, it, vi } from "vitest";
import { baseSepolia } from "viem/chains";
import type { Pool } from "../src/db/pool.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { StandardConfirmationState } from "../src/standardRail/confirmationState.js";

const orderKey = `0x${"ab".repeat(32)}` as const;

function stateWith(finalityTag: "safe" | "finalized") {
  const getBlock = vi.fn(async ({ blockTag }: { blockTag: string }) => ({
    number: blockTag === "latest" ? 105n : 100n,
    hash: `0x${(blockTag === "latest" ? "05" : "00").repeat(32)}`,
  }));
  const readContract = vi.fn(async () => ({
    orderKey,
    payer: "0x1111111111111111111111111111111111111111",
    providerOwner: "0x2222222222222222222222222222222222222222",
    providerAgentWallet: "0x3333333333333333333333333333333333333333",
    confirmation: 1,
    confirmationSubmissions: 1,
    currentConfirmationUid: `0x${"cd".repeat(32)}`,
  }));
  const state = new StandardConfirmationState(
    {} as Pool,
    {
      evidenceRpcUrls: ["https://rpc.example"],
      reputationContract: "0x4444444444444444444444444444444444444444",
      finalityTag,
    } as unknown as StandardRailConfig,
    baseSepolia,
    async () => undefined,
    [{ host: "rpc.example", client: { getBlock, readContract } as never }],
  );
  return { state, getBlock };
}

describe("confirmation state finality tag", () => {
  it("reads the final view at the configured tag: safe on testnet, finalized on mainnet", async () => {
    for (const tag of ["safe", "finalized"] as const) {
      const { state, getBlock } = stateWith(tag);
      const observation = await state.observeFinal(orderKey);
      expect(state.finalityTag).toBe(tag);
      expect(getBlock).toHaveBeenCalledWith({ blockTag: tag });
      expect(observation).toMatchObject({ state: "Confirmed", blockNumber: "100" });
    }
  });

  it("keeps a latest read a latest read whatever the tag", async () => {
    const { state, getBlock } = stateWith("safe");
    const latest = await state.observe(orderKey, "latest");
    expect(getBlock).toHaveBeenCalledWith({ blockTag: "latest" });
    expect(latest.blockNumber).toBe("105");
  });
});
