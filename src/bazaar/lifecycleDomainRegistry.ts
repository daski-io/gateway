import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import { isHex32, isHexAddress } from "../util/evmValidation.js";
import type { BazaarListing } from "./types.js";

interface RawLifecycleDomain {
  chain_id: string;
  pay_to: Buffer;
  offer_signer: Buffer;
  listing_epoch: Buffer;
  listing_commitment: Buffer;
  provider_agent_id: string;
  outcome_id: Buffer;
}

export async function reconcileLifecycleDomains(input: {
  pool: Pool;
  listings: BazaarListing[];
  retiredCommitments: Hex[];
  providerActionSigner: Hex;
  retentionSeconds: number;
}): Promise<void> {
  if (!Number.isSafeInteger(input.retentionSeconds) || input.retentionSeconds < 1) {
    throw new Error("Bazaar lifecycle-domain retention must be a positive integer");
  }
  if (!isHexAddress(input.providerActionSigner)) {
    throw new Error("Bazaar lifecycle-domain signer is malformed");
  }
  const activeCommitments = new Set(
    input.listings.map((listing) =>
      listing.offer.message.listingCommitment.toLowerCase()),
  );
  const retiredCommitments = new Set<string>();
  for (const commitment of input.retiredCommitments) {
    const normalized = commitment.toLowerCase();
    if (
      !isHex32(commitment) || activeCommitments.has(normalized) ||
      retiredCommitments.has(normalized)
    ) throw new Error("Bazaar lifecycle-domain retirement set is invalid");
    retiredCommitments.add(normalized);
  }
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["daski-gateway:bazaar-lifecycle-domains"],
    );
    const signerConflict = await client.query(
      `SELECT 1 FROM bazaar_lifecycle_domains
        WHERE (pay_to = $1 OR offer_signer = $1)
          AND (active OR accept_until > now())
        LIMIT 1`,
      [hexToBytea(input.providerActionSigner)],
    );
    if (signerConflict.rowCount === 1) {
      throw new Error("Bazaar lifecycle signer reuses a retained financial key");
    }
    for (const listing of input.listings) {
      const offer = listing.offer.message;
      const values = [
        offer.chainId.toString(),
        hexToBytea(offer.payTo),
        hexToBytea(offer.offerSigner),
        hexToBytea(offer.listingEpoch),
        hexToBytea(offer.listingCommitment),
        offer.providerAgentId.toString(),
        hexToBytea(offer.outcomeId),
      ] as const;
      await client.query(
        `INSERT INTO bazaar_lifecycle_domains
           (chain_id, pay_to, offer_signer, listing_epoch, listing_commitment,
            provider_agent_id, outcome_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [...values],
      );
      const stored = await client.query<RawLifecycleDomain>(
        `SELECT chain_id, pay_to, offer_signer, listing_epoch, listing_commitment,
                provider_agent_id, outcome_id
           FROM bazaar_lifecycle_domains
          WHERE (chain_id = $1 AND pay_to = $2)
             OR listing_epoch = $3 OR listing_commitment = $4`,
        [values[0], values[1], values[3], values[4]],
      );
      if (stored.rows.length !== 1 || !domainMatches(stored.rows[0]!, values)) {
        throw new Error("Bazaar lifecycle domain was previously rebound");
      }
      const active = await client.query<{ active: boolean }>(
        `SELECT active FROM bazaar_lifecycle_domains
          WHERE chain_id = $1 AND pay_to = $2`,
        values.slice(0, 2),
      );
      if (active.rows[0]?.active !== true) {
        throw new Error("Bazaar lifecycle domain cannot be reactivated after retirement");
      }
    }
    for (const commitment of input.retiredCommitments) {
      const retired = await client.query<{ active: boolean }>(
        `SELECT active FROM bazaar_lifecycle_domains
          WHERE listing_commitment = $1 FOR UPDATE`,
        [hexToBytea(commitment)],
      );
      if (!retired.rows[0]) {
        throw new Error("Bazaar lifecycle retirement references an unknown domain");
      }
      if (!retired.rows[0].active) continue;
      await client.query(
        `UPDATE bazaar_lifecycle_domains
            SET active = FALSE, retired_at = now(),
                accept_until = now() + make_interval(secs => $2),
                updated_at = now()
          WHERE listing_commitment = $1`,
        [hexToBytea(commitment), input.retentionSeconds],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function domainMatches(
  row: RawLifecycleDomain,
  values: readonly [string, Buffer, Buffer, Buffer, Buffer, string, Buffer],
): boolean {
  return row.chain_id === values[0] && row.pay_to.compare(values[1]) === 0 &&
    row.offer_signer.compare(values[2]) === 0 &&
    row.listing_epoch.compare(values[3]) === 0 &&
    row.listing_commitment.compare(values[4]) === 0 &&
    row.provider_agent_id === values[5] && row.outcome_id.compare(values[6]) === 0;
}
