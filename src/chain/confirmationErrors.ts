import type { Hex } from "../types.js";

// ── Buyer-confirmation failure taxonomy ──────────────────────────────────
//
// Buyer-confirmation submission used to throw a plain Error for every failure,
// and `runConfirmDelivery` collapsed all of them into one `submit_failed`.
// Three genuinely different outcomes hid behind that single code, and they
// call for opposite recoveries:
//
//   validation — the pre-flight `eth_call` reverted. Nothing was broadcast,
//                the EAS attester nonce was NOT consumed, and the SAME
//                signed attestation can be resubmitted... unless the revert
//                was itself about the signature (expired deadline, nonce
//                mismatch, bad signature), in which case a bare retry fails
//                deterministically and the buyer needs a fresh
//                prepareConfirmation. `needsFreshSignature` splits those.
//   reverted   — the transaction was mined and reverted. No attestation
//                exists and the nonce is untouched, but the failure already
//                survived simulation, so a bare retry is unlikely to help.
//   unknown    — the write or the receipt wait failed. The transaction MAY
//                be in flight. Blind-retrying risks a duplicate
//                attestation; the caller must read chain state first.
//   attestation— the receipt succeeded (so the nonce IS consumed and an
//                attestation DOES exist) but no Attested event could be
//                located. On-chain truth and our records have diverged;
//                this needs operator recovery, never a retry.

export type ConfirmationFailureStage =
  | "validation"
  | "reverted"
  | "unknown"
  | "attestation";

export class ConfirmationSubmitError extends Error {
  readonly stage: ConfirmationFailureStage;
  /** Present once a transaction was actually broadcast. */
  readonly transactionHash?: Hex;
  /** validation-stage only: a retry needs a NEW signed authorization. */
  readonly needsFreshSignature: boolean;

  constructor(
    stage: ConfirmationFailureStage,
    message: string,
    options: { transactionHash?: Hex; needsFreshSignature?: boolean } = {},
  ) {
    super(message);
    this.name = "ConfirmationSubmitError";
    this.stage = stage;
    this.transactionHash = options.transactionHash;
    this.needsFreshSignature = options.needsFreshSignature ?? false;
  }
}

// EAS reverts that invalidate the buyer's signed authorization itself. The
// resolver's own reverts (unauthorized attester, duplicate confirmation)
// are deliberately NOT here: those are about the request, not the
// signature, and re-signing would not change the outcome.
const SIGNATURE_INVALIDATING = [
  /deadline\s*expired/i,
  /\bDeadlineExpired\b/,
  /invalid\s*signature/i,
  /\bInvalidSignature\b/,
  /invalid\s*nonce/i,
  /\bInvalidNonce\b/,
  /nonce\s*(mismatch|too|already)/i,
];

export function revertInvalidatesSignature(reason: string): boolean {
  return SIGNATURE_INVALIDATING.some((pattern) => pattern.test(reason));
}
