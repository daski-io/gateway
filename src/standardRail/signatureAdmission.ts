import type { Pool } from "../db/pool.js";
import { standardRailError, type StandardRailPhase } from "./errors.js";

export const SIGNATURE_VERIFY_BUCKET_KEY = "standard-signature:global";

/**
 * The admission every contract-path verification charges before its RPC
 * call: one budget per minute for all clients together, because each
 * verification is one RPC call and the RPC plan is one budget. It is not
 * keyed by the claimed payer (the payer is exactly what the verification has
 * yet to establish, so a per-payer charge was attacker-attributable: any
 * client naming a victim could exhaust it and lock that wallet out of every
 * paid path), and since 2026-09-25 not by the client either: the edge limits
 * each caller's requests, and a per-client charge never bounded the total.
 * One auto-committed statement on the shared bucket table: no transaction
 * and no connection is held while the chain is consulted, and a verification
 * that then fails has still been counted.
 */
export async function chargeSignatureVerifyAdmission(
  pool: Pick<Pool, "query">,
  maximumPerMinute: number,
  context?: { field?: string; phase?: StandardRailPhase },
): Promise<void> {
  const rate = await pool.query<{ request_count: number }>(
    `INSERT INTO rate_limit_buckets(bucket_key,window_started_at,request_count)
     VALUES ($1,now(),1) ON CONFLICT (bucket_key) DO UPDATE SET
       window_started_at=CASE WHEN rate_limit_buckets.window_started_at<=now()-interval '1 minute'
         THEN now() ELSE rate_limit_buckets.window_started_at END,
       request_count=CASE WHEN rate_limit_buckets.window_started_at<=now()-interval '1 minute'
         THEN 1 ELSE rate_limit_buckets.request_count+1 END RETURNING request_count`,
    [SIGNATURE_VERIFY_BUCKET_KEY],
  );
  if ((rate.rows[0]?.request_count ?? maximumPerMinute + 1) > maximumPerMinute) {
    throw standardRailError("SIGNATURE_VERIFICATION_BUSY", {
      field: context?.field,
      phase: context?.phase,
      message: "Signature verification admission is exhausted for the current minute",
    });
  }
}
