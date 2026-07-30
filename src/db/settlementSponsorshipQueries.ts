import type { PoolClient } from "pg";
import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";

export type SettlementSponsorshipLimit = "wallet" | "global";

export function createSettlementSponsorshipQueries(_pool: Pool) {
  return {
    async reserveSettlementSponsorship(
      client: PoolClient,
      input: {
        wallet: Hex;
        walletDailyLimit: number;
        globalDailyLimit: number;
      },
    ): Promise<SettlementSponsorshipLimit | null> {
      const walletKey = `wallet:${input.wallet.toLowerCase()}`;
      if (!(await consumeBucket(client, walletKey, input.walletDailyLimit))) {
        return "wallet";
      }
      if (!(await consumeBucket(client, "global", input.globalDailyLimit))) {
        return "global";
      }
      return null;
    },
  };
}

async function consumeBucket(
  client: PoolClient,
  key: string,
  limit: number,
): Promise<boolean> {
  const result = await client.query<{ sponsorship_count: number }>(
    `INSERT INTO settlement_sponsorship_buckets
       (bucket_key, window_date, sponsorship_count)
     VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (bucket_key, window_date) DO UPDATE
       SET sponsorship_count =
             settlement_sponsorship_buckets.sponsorship_count + 1,
           updated_at = now()
       WHERE settlement_sponsorship_buckets.sponsorship_count < $2
     RETURNING sponsorship_count`,
    [key, limit],
  );
  return result.rowCount === 1;
}
