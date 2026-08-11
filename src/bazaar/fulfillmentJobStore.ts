import type { PoolClient } from "pg";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";

export async function createBazaarFulfillmentJob(
  client: PoolClient,
  orderRecordId: Hex,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO bazaar_fulfillment_jobs (order_record_id) VALUES ($1)
     ON CONFLICT DO NOTHING`,
    [hexToBytea(orderRecordId)],
  );
  if (result.rowCount !== 1) throw new Error(
    "Bazaar fulfillment job already exists for new dispatch",
  );
}
