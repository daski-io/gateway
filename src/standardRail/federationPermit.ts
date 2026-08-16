import type { Pool } from "../db/pool.js";
import type { PoolClient } from "pg";

const POLL_INTERVAL_MS = 25;

interface HeldPermit {
  key: string;
  release: () => Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

/**
 * Uses session advisory locks as deployment-wide concurrency slots. The
 * provider slot is acquired first so one stalled provider can occupy at most
 * its own allowance of global slots across all gateway replicas.
 */
export async function withFederationPermit<T>(args: {
  pool: Pool;
  providerAgentId: string;
  providerLimit: number;
  globalLimit: number;
  timeoutMs: number;
  work: () => Promise<T>;
}): Promise<T> {
  const deadline = Date.now() + args.timeoutMs;
  const client = await args.pool.connect();
  const held: HeldPermit[] = [];
  try {
    held.push(await acquireSlot(
      client,
      `standard:federation:provider:${args.providerAgentId}`,
      args.providerLimit,
      deadline,
    ));
    held.push(await acquireSlot(
      client,
      "standard:federation:global",
      args.globalLimit,
      deadline,
    ));
    return await args.work();
  } finally {
    for (const permit of held.reverse()) await permit.release().catch(() => undefined);
    client.release();
  }
}

async function acquireSlot(
  client: PoolClient,
  scope: string,
  limit: number,
  deadline: number,
): Promise<HeldPermit> {
  while (Date.now() < deadline) {
    for (let slot = 0; slot < limit; slot += 1) {
      const key = `${scope}:${slot}`;
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [key],
      );
      if (result.rows[0]?.acquired) {
        return {
          key,
          release: async () => {
            await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
          },
        };
      }
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error("FEDERATION_CAPACITY_TIMEOUT");
}
