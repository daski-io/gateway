import { describe, expect, it, vi } from "vitest";
import { baseSepolia } from "viem/chains";
import type { Pool } from "../src/db/pool.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { StandardConfirmations } from "../src/standardRail/confirmations.js";
import type { StandardOrderRecord } from "../src/standardRail/types.js";
import { withRpcFailover } from "../src/rpc/failover.js";

const endpoints = [
  { host: "primary.example", client: "primary" },
  { host: "fallback.example", client: "fallback" },
] as const;

describe("withRpcFailover", () => {
  it("does not contact a fallback when the primary succeeds", async () => {
    const observe = vi.fn(async ({ client }: (typeof endpoints)[number]) => client);

    await expect(withRpcFailover(endpoints, observe, { baseDelayMs: 0 }))
      .resolves.toBe("primary");
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(endpoints[0]);
  });

  it("exhausts primary retries before selecting a fallback", async () => {
    const selected: string[] = [];
    const onFallback = vi.fn();
    const result = await withRpcFailover(endpoints, async ({ client }) => {
      selected.push(client);
      if (client === "primary") throw new Error("primary unavailable");
      return client;
    }, { attempts: 3, baseDelayMs: 0, onFallback });

    expect(result).toBe("fallback");
    expect(selected).toEqual(["primary", "primary", "primary", "fallback"]);
    expect(onFallback).toHaveBeenCalledWith({
      primaryHost: "primary.example",
      selectedHost: "fallback.example",
    });
  });

  it("rethrows a terminal error at once, without retries or failover", async () => {
    class DeterministicAnswer extends Error {}
    const answer = new DeterministicAnswer("not registered");
    const observe = vi.fn(async () => { throw answer; });
    const onFallback = vi.fn();

    await expect(withRpcFailover(endpoints, observe, {
      attempts: 3,
      baseDelayMs: 0,
      onFallback,
      terminal: (error) => error instanceof DeterministicAnswer,
    })).rejects.toBe(answer);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(endpoints[0]);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("keeps retrying and failing over when the terminal predicate declines", async () => {
    const observe = vi.fn(async ({ client }: (typeof endpoints)[number]) => {
      if (client === "primary") throw new Error("primary unavailable");
      return client;
    });

    await expect(withRpcFailover(endpoints, observe, {
      attempts: 2,
      baseDelayMs: 0,
      terminal: () => false,
    })).resolves.toBe("fallback");
    expect(observe).toHaveBeenCalledTimes(3);
  });

  it("fails closed after every endpoint exhausts its retries", async () => {
    const promise = withRpcFailover(endpoints, async ({ host }) => {
      throw new Error(host + " unavailable");
    }, { attempts: 1, baseDelayMs: 0 });

    await expect(promise).rejects.toMatchObject({
      name: "AggregateError",
      message: "RPC observation failed on the primary and every configured fallback",
      errors: [{}, {}],
    });
  });
});

describe("StandardConfirmations RPC selection", () => {
  it("keeps confirmation reads on a healthy primary", async () => {
    const orderKey = `0x${"11".repeat(32)}` as const;
    const payer = "0x2222222222222222222222222222222222222222" as const;
    const primary = { readContract: vi.fn(async () => ({ orderKey, payer })) };
    const fallback = { readContract: vi.fn() };
    const confirmations = new StandardConfirmations(
      {} as Pool,
      {
        evidenceRpcUrls: ["https://primary.example", "https://fallback.example"],
        reputationContract: "0x3333333333333333333333333333333333333333",
      } as unknown as StandardRailConfig,
      baseSepolia,
    );
    Object.assign(confirmations as unknown as { clients: unknown[] }, {
      clients: [
        { host: "primary.example", client: primary },
        { host: "fallback.example", client: fallback },
      ],
    });

    const record = await (confirmations as unknown as {
      current(order: StandardOrderRecord): Promise<{ orderKey: string; payer: string }>;
    }).current({
      orderKey,
      payer,
    } as unknown as StandardOrderRecord);

    expect(record).toMatchObject({ orderKey, payer });
    expect(primary.readContract).toHaveBeenCalledOnce();
    expect(fallback.readContract).not.toHaveBeenCalled();
  });
});
