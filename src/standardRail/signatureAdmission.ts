import type { Address } from "viem";
import type { Pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";
import { standardRailError } from "./errors.js";

export const SIGNATURE_VERIFY_SCOPE = "signature-verify";

export function signatureVerifyBucketKey(payer: Address): string {
  return `standard-signature:${canonicalHash({ scope: SIGNATURE_VERIFY_SCOPE, payer: payer.toLowerCase() })}`;
}

/**
 * The per-payer admission every contract-path verification charges before
 * its RPC call. One auto-committed statement on the shared bucket table: no
 * transaction and no connection is held while the chain is consulted, and a
 * verification that then fails has still been counted.
 */
export async function chargeSignatureVerifyAdmission(
  pool: Pick<Pool, "query">,
  payer: Address,
  maximumPerMinute: number,
): Promise<void> {
  const rate = await pool.query<{ request_count: number }>(
    `INSERT INTO rate_limit_buckets(bucket_key,window_started_at,request_count)
     VALUES ($1,now(),1) ON CONFLICT (bucket_key) DO UPDATE SET
       window_started_at=CASE WHEN rate_limit_buckets.window_started_at<=now()-interval '1 minute'
         THEN now() ELSE rate_limit_buckets.window_started_at END,
       request_count=CASE WHEN rate_limit_buckets.window_started_at<=now()-interval '1 minute'
         THEN 1 ELSE rate_limit_buckets.request_count+1 END RETURNING request_count`,
    [signatureVerifyBucketKey(payer)],
  );
  if ((rate.rows[0]?.request_count ?? maximumPerMinute + 1) > maximumPerMinute) {
    throw standardRailError("SIGNATURE_VERIFICATION_BUSY", {
      message: "Signature verification admission for this payer is exhausted for the current minute",
    });
  }
}
