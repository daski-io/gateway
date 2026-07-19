import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries, ReputationMirrorRow } from "../db/queries.js";
import type { Hex } from "../types.js";
import { logErrorWithId } from "../util/errorWrap.js";

// ── Canonical ERC-8004 feedback mirror ────────────────────────────────────
//
// After a buyer confirmation lands on EAS, the gateway mirrors it as PUBLIC
// feedback for the provider on the canonical per-chain ReputationRegistry
// (0x8004B…). The facilitator wallet is the submitting client — the
// orchestrator-client role the ERC-8004 spec allows — and the EAS
// attestation is the evidence each entry cites. This is what makes Daski
// reputation portable: any ERC-8004 consumer can read it without knowing
// anything about Daski's own contracts.
//
// Feedback convention (locked):
//   value        = 100 (Confirmed) / 0 (NotConfirmed), valueDecimals = 0
//   tag1         = "daski"            (ecosystem filter tag)
//   tag2         = service slug when the payment came through this gateway
//                  (from the local challenge row), "" otherwise
//   endpoint     = ""
//   feedbackURI  = easscan deep-link to the buyer's confirmation
//                  attestation (per-chain easscan host)
//   feedbackHash = the EAS attestation UID itself — binds the entry to
//                  immutable on-chain evidence instead of hashing a mutable
//                  HTML page
//
// Spec caution: giveFeedback reverts if the submitting client is the
// agent's owner / ERC-721 operator / approved spender / agentWallet (the
// arms-length rule). If the facilitator wallet ever controls a provider
// agent, the mirror logs a failure for that provider and moves on — that
// is correct behavior, not a bug.
//
// The mirror is fire-and-forget from the confirmation path: it must NEVER
// delay or fail the buyer's confirmation response. All outcomes land in
// the reputation_mirrors table (migration 009) so retries are idempotent
// and revisions can revoke the prior entry.

export interface MirrorDeps {
  config: Config;
  reader: ChainReader;
  queries: Queries;
}

export interface MirrorArgs {
  paymentId: bigint;
  confirmation: "Confirmed" | "NotConfirmed";
  /** UID of the EAS confirmation attestation just submitted. */
  attestationUid: Hex;
  /** EAS refUID when this confirmation revises a prior one; null on first. */
  refUid: Hex | null;
}

/** Returned for observability/tests; the confirm path ignores it. */
export type MirrorOutcome =
  | { mirrored: true; feedbackIndex: bigint; transactionHash: Hex }
  | {
      mirrored: false;
      reason: "disabled" | "duplicate" | "ineligible" | "failed";
    };

const FEEDBACK_TAG1 = "daski";
const CONFIRMED_VALUE = 100n;
const NOT_CONFIRMED_VALUE = 0n;

/** Per-chain easscan host for the feedbackURI deep-link. */
export function easscanAttestationUrl(chainId: number, uid: Hex): string {
  const host =
    chainId === 8453 ? "base.easscan.org" : "base-sepolia.easscan.org";
  return `https://${host}/attestation/view/${uid}`;
}

export async function mirrorConfirmationFeedback(
  deps: MirrorDeps,
  args: MirrorArgs,
): Promise<MirrorOutcome> {
  // Mirror off: no canonical registry configured (operator choice), or the
  // gateway is running against the in-process mock chain (CHAIN_MODE=mock —
  // same env var index.ts boots on; there is no canonical registry to write
  // to in that world). index.ts logs the enabled/disabled state once at
  // startup, so per-call we stay quiet.
  if (
    !deps.config.reputationRegistryAddress ||
    deps.config.chainMode === "mock"
  ) {
    return { mirrored: false, reason: "disabled" };
  }

  let existing: ReputationMirrorRow | null = null;
  try {
    existing = await deps.queries.getReputationMirror(args.paymentId);
  } catch (err) {
    logErrorWithId("reputationMirror.lookup", err);
    return { mirrored: false, reason: "failed" };
  }

  // First-confirmation retry (no refUID): the canonical entry is already
  // live — skip silently instead of double-posting. Revisions (refUID set)
  // and prior failures fall through to (re-)post.
  if (!args.refUid && existing?.status === "sent") {
    return { mirrored: false, reason: "duplicate" };
  }

  try {
    // The router record is authoritative for both provider identity and
    // reputation eligibility. The local challenge only supplies tag2.
    const [record, challenge] = await Promise.all([
      deps.reader.getPaymentRecord(args.paymentId),
      deps.queries.getChallengeByPaymentId(args.paymentId),
    ]);
    if (!record) {
      throw new Error(
        `payment ${args.paymentId} has no authoritative router record`,
      );
    }
    if (!record.reputationEligible) {
      return { mirrored: false, reason: "ineligible" };
    }
    const providerAgentId = record.providerAgentId;
    const tag2 = challenge?.serviceSlug ?? "";

    // Revision: EAS confirmations revise in place via refUID chains, but
    // the canonical registry has no edit — so best-effort revoke the prior
    // entry first, then post fresh. "no such feedback" / "already revoked"
    // (e.g. a crashed earlier revision) must not block the fresh post.
    if (args.refUid && existing?.feedbackIndex != null) {
      const revokeAgentId = existing.providerAgentId ?? providerAgentId;
      try {
        await deps.reader.revokeFeedback(revokeAgentId, existing.feedbackIndex);
      } catch (err) {
        logErrorWithId("reputationMirror.revoke", err);
      }
    }

    const { transactionHash } = await deps.reader.giveFeedback({
      agentId: providerAgentId,
      value:
        args.confirmation === "Confirmed"
          ? CONFIRMED_VALUE
          : NOT_CONFIRMED_VALUE,
      valueDecimals: 0,
      tag1: FEEDBACK_TAG1,
      tag2,
      endpoint: "",
      feedbackURI: easscanAttestationUrl(
        deps.config.chainId,
        args.attestationUid,
      ),
      feedbackHash: args.attestationUid,
    });

    // Persist the (1-based, per-(agent, client)) index of the entry we just
    // posted — it's what a future revision needs to revoke it.
    const feedbackIndex = await deps.reader.getFeedbackLastIndex(
      providerAgentId,
    );

    await deps.queries.upsertReputationMirror({
      paymentId: args.paymentId,
      attestationUid: args.attestationUid,
      providerAgentId,
      feedbackIndex,
      txHash: transactionHash,
      status: "sent",
    });

    return { mirrored: true, feedbackIndex, transactionHash };
  } catch (err) {
    // Includes the arms-length revert documented above. A later
    // confirmation retry (same paymentId) naturally re-attempts.
    logErrorWithId("reputationMirror", err);
    try {
      await deps.queries.upsertReputationMirror({
        paymentId: args.paymentId,
        attestationUid: args.attestationUid,
        // Preserve a previously-posted entry's coordinates: if a revision
        // failed after the revoke was swallowed, the retry still needs the
        // old index to revoke the (possibly still live) prior entry.
        providerAgentId: existing?.providerAgentId ?? null,
        feedbackIndex: existing?.feedbackIndex ?? null,
        txHash: existing?.txHash ?? null,
        status: "failed",
      });
    } catch (dbErr) {
      logErrorWithId("reputationMirror.persistFailure", dbErr);
    }
    return { mirrored: false, reason: "failed" };
  }
}
