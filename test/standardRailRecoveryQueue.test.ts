import { describe, expect, it, vi } from "vitest";
import type { Pool } from "../src/db/pool.js";
import { isTerminalState } from "../src/standardRail/stateMachine.js";
import {
  RECOVERABLE_ORDER_STATES,
  StandardRailStore,
} from "../src/standardRail/store.js";
import type {
  StandardOrderRecord,
  StandardOrderState,
} from "../src/standardRail/types.js";

describe("standard rail recovery queue", () => {
  it("cannot let hundreds of terminal orders starve recoverable work", async () => {
    let leasedStates: readonly string[] | undefined;
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("SELECT * FROM standard_orders")) {
        leasedStates = values?.[0] as readonly string[];
        return { rows: [] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const store = new StandardRailStore(pool);

    await expect(store.leaseRecoverable("worker-1", 30)).resolves.toBeNull();

    const terminalStates = [
      "FULFILLED",
      "PROVIDER_FAILED",
      "LEGAL_HOLD",
      "NOT_SETTLED",
    ] as const satisfies readonly StandardOrderState[];
    const terminalBacklog = Array.from(
      { length: 500 },
      (_, index) => terminalStates[index % terminalStates.length]!,
    );
    expect(terminalBacklog.every(isTerminalState)).toBe(true);
    expect(leasedStates).toEqual(RECOVERABLE_ORDER_STATES);
    expect(
      terminalBacklog.filter((state) => leasedStates?.includes(state)).length,
    ).toBe(0);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("keeps every leased state nonterminal", () => {
    expect(RECOVERABLE_ORDER_STATES.every((state) => !isTerminalState(state)))
      .toBe(true);
  });

  it("releases terminal capacity before committing the state transition", async () => {
    const calls: string[] = [];
    const now = new Date();
    const row = {
      order_id: "order-1",
      order_key: Buffer.alloc(32),
      order_handle: "handle-1",
      handle_hash: Buffer.alloc(32),
      state: "FULFILLED",
      provider_agent_id: "7",
      outcome_id: "outcome",
      binding_profile: "stock-fixed-v1",
      listing_manifest_hash: Buffer.alloc(32),
      provider_offer_hash: Buffer.alloc(32),
      canonical_listing: {},
      quote_hash: Buffer.alloc(32),
      canonical_quote: {},
      canonical_request_hash: Buffer.alloc(32),
      canonical_request: {},
      order_nonce: Buffer.alloc(32),
      authorization_key: null,
      payment_payload_hash: null,
      payer: null,
      gross_amount: "1",
      provider_net_amount: null,
      daski_commission_amount: null,
      encrypted_payment_payload: null,
      settlement_tx_hash: null,
      deposit_evidence_hash: null,
      release_tx_hash: null,
      release_evidence_hash: null,
      provider_task_id: "task-1",
      rail_epoch: "1",
      version: "2",
      lease_fence: "0",
      expires_at: now,
      created_at: now,
      updated_at: now,
    };
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.trim().replace(/\s+/g, " ");
      calls.push(normalized);
      return normalized.startsWith("UPDATE standard_orders SET")
        ? { rows: [row] }
        : { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const store = new StandardRailStore(pool);
    const order = {
      orderId: "order-1",
      state: "DISPATCHED",
      version: 1,
      leaseFence: 0,
    } as StandardOrderRecord;

    await expect(
      store.transition(order, "FULFILLED", "provider_terminal_completed"),
    ).resolves.toMatchObject({ state: "FULFILLED" });

    const terminalUpdate = calls.findIndex((sql) =>
      sql.startsWith("UPDATE standard_capacity_reservations")
    );
    const commit = calls.indexOf("COMMIT");
    expect(terminalUpdate).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(terminalUpdate);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
