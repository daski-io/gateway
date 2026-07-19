import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";

export interface BuyerIdentity {
  agentId: bigint;
  walletAddress: Hex;
  resolvedName: string;
  agentURI: string;
}

export function createBuyerIdentityQueries(pool: Pool) {
  return {
    async upsertBuyerIdentity(row: BuyerIdentity): Promise<void> {
      await pool.query(
        `INSERT INTO buyer_identities
           (agent_id, wallet_address, resolved_name, agent_uri)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (agent_id) DO UPDATE SET
           wallet_address = EXCLUDED.wallet_address,
           resolved_name = EXCLUDED.resolved_name,
           agent_uri = EXCLUDED.agent_uri,
           updated_at = now()`,
        [
          row.agentId.toString(),
          row.walletAddress.toLowerCase(),
          row.resolvedName,
          row.agentURI,
        ],
      );
    },

    async getBuyerIdentity(agentId: bigint): Promise<BuyerIdentity | null> {
      const result = await pool.query<{
        agent_id: string;
        wallet_address: string;
        resolved_name: string;
        agent_uri: string;
      }>(
        `SELECT agent_id, wallet_address, resolved_name, agent_uri
           FROM buyer_identities
          WHERE agent_id = $1`,
        [agentId.toString()],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        agentId: BigInt(row.agent_id),
        walletAddress: row.wallet_address as Hex,
        resolvedName: row.resolved_name,
        agentURI: row.agent_uri,
      };
    },
  };
}
