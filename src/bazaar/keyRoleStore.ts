import type { PoolClient } from "pg";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";

export type BazaarKeyRole =
  | "provider"
  | "fulfillment"
  | "daski_lifecycle"
  | "daski_refund"
  | "daski_manifest";

export async function bindBazaarKeyRole(
  client: PoolClient,
  address: Hex,
  role: BazaarKeyRole,
): Promise<void> {
  const value = hexToBytea(address);
  await client.query(
    `INSERT INTO bazaar_key_roles (key_address, key_role)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [value, role],
  );
  const stored = await client.query<{ key_role: string }>(
    "SELECT key_role FROM bazaar_key_roles WHERE key_address = $1",
    [value],
  );
  if (stored.rows.length !== 1 || stored.rows[0]!.key_role !== role) {
    throw new Error("Bazaar key reuses a historical trust role");
  }
}
