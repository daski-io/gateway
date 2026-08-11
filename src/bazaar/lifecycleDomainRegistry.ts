import type { PoolClient } from "pg";
import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import type { BazaarListing } from "./types.js";
import { bindBazaarKeyRole } from "./keyRoleStore.js";
import { validateLifecycleDomainInput } from "./lifecycleDomainValidation.js";

const MAX_PUBLISHED_LIFECYCLE_DOMAINS = 1_000;

interface RawLifecycleDomain {
  chain_id: string;
  pay_to: Buffer;
  offer_signer: Buffer;
  listing_epoch: Buffer;
  listing_commitment: Buffer;
  provider_agent_id: string;
  outcome_id: Buffer;
}

interface RawPublishedLifecycleDomain extends RawLifecycleDomain {
  active: boolean;
  accept_until: string | null;
}

export interface PublishedLifecycleDomainV1 {
  chainId: string;
  payTo: Hex;
  offerSigner: Hex;
  listingEpoch: Hex;
  listingCommitment: Hex;
  providerAgentId: string;
  outcomeId: Hex;
  status: "active" | "retired";
  acceptUntil?: string;
}

export async function reconcileLifecycleDomains(input: {
  pool: Pool;
  listings: BazaarListing[];
  retiredCommitments: Hex[];
  providerActionSigner: Hex;
  refundInstructionSigner: Hex;
  providerRefundWallets: Hex[];
  retentionSeconds: number;
}): Promise<void> {
  validateLifecycleDomainInput(input);
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await reconcileLifecycleDomainsInTransaction(client, input);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileLifecycleDomainsInTransaction(
  client: PoolClient,
  input: Omit<Parameters<typeof reconcileLifecycleDomains>[0], "pool">,
): Promise<void> {
  validateLifecycleDomainInput(input);
  await lockLifecycleDomainRegistry(client);
  await bindBazaarKeyRole(
    client,
    input.providerActionSigner,
    "daski_lifecycle",
  );
  await bindBazaarKeyRole(
    client,
    input.refundInstructionSigner,
    "daski_refund",
  );
  const refundSignerConflict = await client.query(
    `SELECT 1 FROM bazaar_exposures
      WHERE state <> 'released' AND refund_wallet IN ($1, $2)
      LIMIT 1`,
    [
      hexToBytea(input.providerActionSigner),
      hexToBytea(input.refundInstructionSigner),
    ],
  );
  if (refundSignerConflict.rowCount === 1) {
    throw new Error("Bazaar Daski signer reuses an outstanding refund key");
  }
  await reconcileLifecycleListingDomains(client, input);
}

export async function lockLifecycleDomainRegistry(client: PoolClient): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    ["daski-gateway:bazaar-lifecycle-domains"],
  );
}

async function reconcileLifecycleListingDomains(
  client: PoolClient,
  input: Omit<Parameters<typeof reconcileLifecycleDomains>[0], "pool">,
): Promise<void> {
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
  const providerRoleConflict = await client.query(
    `SELECT 1 FROM bazaar_key_roles r
      JOIN bazaar_exposures e ON r.key_address = e.refund_wallet
      WHERE r.key_role = 'fulfillment' AND e.state <> 'released'
      LIMIT 1`,
  );
  if (providerRoleConflict.rowCount === 1) {
    throw new Error(
      "Bazaar fulfillment signer reuses a historical provider key",
    );
  }
  for (const wallet of new Set(input.providerRefundWallets.map((value) =>
    value.toLowerCase()))) {
    const fulfillmentConflict = await client.query(
      `SELECT 1 FROM bazaar_key_roles
        WHERE key_address = $1 AND key_role = 'fulfillment' LIMIT 1`,
      [hexToBytea(wallet as Hex)],
    );
    if (fulfillmentConflict.rowCount === 1) {
      throw new Error("Bazaar refund wallet reuses a fulfillment key");
    }
  }
  const accepted = await client.query<{ count: string }>(
    `SELECT count(*) AS count FROM bazaar_lifecycle_domains
      WHERE active OR accept_until > now()`,
  );
  if (BigInt(accepted.rows[0]?.count ?? "0") > MAX_PUBLISHED_LIFECYCLE_DOMAINS) {
    throw new Error("Bazaar lifecycle-domain registry exceeds its authority limit");
  }
}

export async function readLifecycleDomains(
  pool: Pool | PoolClient,
): Promise<PublishedLifecycleDomainV1[]> {
  const result = await pool.query<RawPublishedLifecycleDomain>(
    `SELECT chain_id, pay_to, offer_signer, listing_epoch, listing_commitment,
            provider_agent_id, outcome_id, active,
            CASE WHEN accept_until IS NULL THEN NULL
                 ELSE floor(extract(epoch FROM accept_until))::text
            END AS accept_until
       FROM bazaar_lifecycle_domains
      WHERE active OR accept_until > now()
      ORDER BY chain_id, pay_to
      LIMIT 1001`,
  );
  if (result.rows.length > MAX_PUBLISHED_LIFECYCLE_DOMAINS) {
    throw new Error("Bazaar lifecycle-domain registry exceeds its publication limit");
  }
  return result.rows.map((row) => ({
    chainId: row.chain_id,
    payTo: toHex(row.pay_to),
    offerSigner: toHex(row.offer_signer),
    listingEpoch: toHex(row.listing_epoch),
    listingCommitment: toHex(row.listing_commitment),
    providerAgentId: row.provider_agent_id,
    outcomeId: toHex(row.outcome_id),
    status: row.active ? "active" : "retired",
    ...(row.accept_until === null ? {} : { acceptUntil: row.accept_until }),
  }));
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

function toHex(value: Buffer): Hex {
  return `0x${value.toString("hex")}` as Hex;
}
