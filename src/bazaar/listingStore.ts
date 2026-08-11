import type { PoolClient } from "pg";
import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import { bindBazaarKeyRole } from "./keyRoleStore.js";
import { listingOfferHash } from "./offer.js";
import type { BazaarListing } from "./types.js";

interface RawBinding {
  pay_to: Buffer;
  listing_commitment: Buffer;
  listing_epoch: Buffer;
  provider_agent_id: string;
  fulfillment_signer: Buffer;
  outcome_id: Buffer;
  resource: string;
}

interface RawOffer {
  offer_id: Buffer;
  offer_hash: Buffer;
  listing_commitment: Buffer;
}

export async function registerListingBindings(
  pool: Pool,
  listings: BazaarListing[],
): Promise<void> {
  await withListingTransaction(pool, (client) =>
    registerActiveListings(client, listings));
}

export async function reconcileListingRuntimeBindingsInTransaction(
  client: PoolClient,
  input: { activeListings: BazaarListing[]; recoveryListings: BazaarListing[] },
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    ["daski-gateway:bazaar-listings"],
  );
  await registerActiveListings(client, input.activeListings);
  for (const listing of input.recoveryListings) {
    await verifyStoredListing(client, listing);
    await verifyStoredKeyRoles(client, listing);
  }
  await assertRecoveryListingCoverage(
    client,
    [...input.activeListings, ...input.recoveryListings],
  );
}

async function withListingTransaction(
  pool: Pool,
  action: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["daski-gateway:bazaar-listings"],
    );
    await action(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function registerActiveListings(
  client: PoolClient,
  listings: BazaarListing[],
): Promise<void> {
  await registerProviderKeyRoles(client, listings);
  for (const listing of listings) {
    const offer = listing.offer.message;
    const values = [
      hexToBytea(offer.payTo),
      hexToBytea(offer.listingCommitment),
      hexToBytea(offer.listingEpoch),
      offer.providerAgentId.toString(),
      hexToBytea(offer.fulfillmentSigner),
      hexToBytea(offer.outcomeId),
      listing.resourceUrl,
    ];
    await client.query(
      `INSERT INTO bazaar_listing_bindings
         (pay_to, listing_commitment, listing_epoch, provider_agent_id,
          fulfillment_signer, outcome_id, resource)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      values,
    );
    const binding = await client.query<RawBinding>(
      `SELECT pay_to, listing_commitment, listing_epoch, provider_agent_id,
              fulfillment_signer, outcome_id, resource
         FROM bazaar_listing_bindings
        WHERE pay_to = $1 OR listing_commitment = $2 OR listing_epoch = $3`,
      values.slice(0, 3),
    );
    if (binding.rows.length !== 1 || !bindingMatches(binding.rows[0]!, values)) {
      throw new Error("Bazaar payTo, commitment, or epoch was previously rebound");
    }
    await registerOffer(client, listing);
  }
}

async function registerOffer(client: PoolClient, listing: BazaarListing): Promise<void> {
  const offer = listing.offer.message;
  const offerHash = listingOfferHash(offer);
  await client.query(
    `INSERT INTO bazaar_listing_offers (offer_id, offer_hash, listing_commitment)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [
      hexToBytea(offer.offerId),
      hexToBytea(offerHash),
      hexToBytea(offer.listingCommitment),
    ],
  );
  const stored = await client.query<RawOffer>(
    `SELECT offer_id, offer_hash, listing_commitment
       FROM bazaar_listing_offers WHERE offer_id = $1 OR offer_hash = $2`,
    [hexToBytea(offer.offerId), hexToBytea(offerHash)],
  );
  if (
    stored.rows.length !== 1 ||
    stored.rows[0]!.offer_id.compare(hexToBytea(offer.offerId)) !== 0 ||
    stored.rows[0]!.offer_hash.compare(hexToBytea(offerHash)) !== 0 ||
    stored.rows[0]!.listing_commitment.compare(
      hexToBytea(offer.listingCommitment),
    ) !== 0
  ) throw new Error("Bazaar offerId was previously rebound");
}

async function assertRecoveryListingCoverage(
  client: PoolClient,
  listings: BazaarListing[],
): Promise<void> {
  const commitments = new Set(listings.map((listing) =>
    listing.listingCommitment.toLowerCase()));
  const required = await client.query<{ listing_commitment: Buffer }>(
    `SELECT DISTINCT listing_commitment FROM bazaar_orders
      WHERE state IN (
        'attempt_opened', 'settle_started', 'settle_confirmed', 'settled',
        'dispatch_started', 'dispatch_ambiguous'
      )`,
  );
  if (required.rows.some((row) =>
    !commitments.has(`0x${row.listing_commitment.toString("hex")}`))) {
    throw new Error("Bazaar recovery listing is missing for outstanding work");
  }
}

async function verifyStoredListing(
  client: PoolClient,
  listing: BazaarListing,
): Promise<void> {
  const offer = listing.offer.message;
  const values = [
    hexToBytea(offer.payTo),
    hexToBytea(offer.listingCommitment),
    hexToBytea(offer.listingEpoch),
    offer.providerAgentId.toString(),
    hexToBytea(offer.fulfillmentSigner),
    hexToBytea(offer.outcomeId),
    listing.resourceUrl,
  ];
  const binding = await client.query<RawBinding>(
    `SELECT pay_to, listing_commitment, listing_epoch, provider_agent_id,
            fulfillment_signer, outcome_id, resource
       FROM bazaar_listing_bindings
      WHERE pay_to = $1 OR listing_commitment = $2 OR listing_epoch = $3`,
    values.slice(0, 3),
  );
  const offerHash = listingOfferHash(offer);
  const storedOffer = await client.query<RawOffer>(
    `SELECT offer_id, offer_hash, listing_commitment
       FROM bazaar_listing_offers WHERE offer_id = $1 OR offer_hash = $2`,
    [hexToBytea(offer.offerId), hexToBytea(offerHash)],
  );
  if (
    binding.rows.length !== 1 || !bindingMatches(binding.rows[0]!, values) ||
    storedOffer.rows.length !== 1 ||
    storedOffer.rows[0]!.offer_id.compare(hexToBytea(offer.offerId)) !== 0 ||
    storedOffer.rows[0]!.offer_hash.compare(hexToBytea(offerHash)) !== 0 ||
    storedOffer.rows[0]!.listing_commitment.compare(
      hexToBytea(offer.listingCommitment),
    ) !== 0
  ) throw new Error("Bazaar recovery listing was not previously admitted");
}

async function verifyStoredKeyRoles(
  client: PoolClient,
  listing: BazaarListing,
): Promise<void> {
  const expected = new Map([
    [listing.offer.message.payTo.toLowerCase(), "provider"],
    [listing.offer.message.offerSigner.toLowerCase(), "provider"],
    [listing.offer.message.fulfillmentSigner.toLowerCase(), "fulfillment"],
  ]);
  for (const [address, role] of expected) {
    const stored = await client.query<{ key_role: string }>(
      "SELECT key_role FROM bazaar_key_roles WHERE key_address = $1",
      [hexToBytea(address as `0x${string}`)],
    );
    if (stored.rows.length !== 1 || stored.rows[0]!.key_role !== role) {
      throw new Error("Bazaar recovery listing has no admitted key roles");
    }
  }
}

function bindingMatches(row: RawBinding, values: unknown[]): boolean {
  const [payTo, commitment, epoch, providerId, signer, outcomeId, resource] = values as [
    Buffer, Buffer, Buffer, string, Buffer, Buffer, string,
  ];
  return row.pay_to.compare(payTo) === 0 &&
    row.listing_commitment.compare(commitment) === 0 &&
    row.listing_epoch.compare(epoch) === 0 &&
    row.provider_agent_id === providerId &&
    row.fulfillment_signer.compare(signer) === 0 &&
    row.outcome_id.compare(outcomeId) === 0 &&
    row.resource === resource;
}

async function registerProviderKeyRoles(
  client: PoolClient,
  listings: BazaarListing[],
): Promise<void> {
  for (const listing of listings) {
    const offer = listing.offer.message;
    await bindBazaarKeyRole(client, offer.payTo, "provider");
    await bindBazaarKeyRole(client, offer.offerSigner, "provider");
    await bindBazaarKeyRole(client, offer.fulfillmentSigner, "fulfillment");
    const refundConflict = await client.query(
      `SELECT 1 FROM bazaar_exposures
        WHERE state <> 'released' AND refund_wallet = $1 LIMIT 1`,
      [hexToBytea(offer.fulfillmentSigner)],
    );
    if (refundConflict.rowCount === 1) {
      throw new Error("Bazaar fulfillment signer reuses an outstanding refund key");
    }
  }
}
