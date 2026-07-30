import { Router, type Request, type Response } from "express";
import { ConfirmationSubmitError } from "../chain/confirmationErrors.js";
import type { Config } from "../config.js";
import { FacilitatorTransactionPendingError } from "../db/facilitatorLockQueries.js";
import type { Queries } from "../db/queries.js";
import type { ChainReader } from "../chain/reader.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import type { Hex } from "../types.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import {
  FacilitatorIntentConflictError,
  FacilitatorTransactionTerminalError,
} from "./facilitatorTransactionCoordinator.js";
import {
  ConfirmationAdmissionError,
  submitConfirmation,
} from "./confirmationSubmission.js";
import {
  parseConfirmInput,
  type ConfirmInput,
} from "./confirmationRequest.js";

export type { ConfirmInput } from "./confirmationRequest.js";

export interface ConfirmDeps {
  config: Config;
  reader: ChainReader;
  queries: Queries;
  reputationWorker: ReputationMirrorWorker;
}

export type ConfirmResult =
  | {
      ok: true;
      paymentId: string;
      confirmation: ConfirmInput["confirmation"];
      attestationUid: Hex;
      transactionHash: Hex;
      refUid: Hex | null;
    }
  | {
      ok: false;
      status: number;
      error: {
        code: string;
        message: string;
        retryable?: boolean;
        details?: Record<string, unknown>;
      };
    };

export async function runConfirmDelivery(
  deps: ConfirmDeps,
  paymentIdValue: string,
  body: unknown,
): Promise<ConfirmResult> {
  let paymentId: bigint;
  try {
    paymentId = BigInt(paymentIdValue);
  } catch {
    return failure(400, "bad_payment_id", "paymentId must be numeric");
  }
  const parsed = parseConfirmInput(body);
  if ("error" in parsed) return failure(400, "bad_input", parsed.error);
  try {
    const result = await submitConfirmation(deps, paymentId, parsed);
    return {
      ok: true,
      paymentId: paymentId.toString(),
      confirmation: parsed.confirmation,
      attestationUid: result.attestationUid,
      transactionHash: result.transactionHash,
      refUid: parsed.refUid,
    };
  } catch (error) {
    return mapConfirmationError(error);
  }
}

function mapConfirmationError(error: unknown): ConfirmResult {
  if (error instanceof ConfirmationAdmissionError) {
    return failure(
      error.status,
      error.code,
      admissionMessage(error.code),
      error.retryable,
    );
  }
  if (error instanceof FacilitatorIntentConflictError) {
    return failure(
      409,
      "operation_intent_conflict",
      "The confirmation operation conflicts with an existing intent.",
    );
  }
  if (error instanceof FacilitatorTransactionPendingError) {
    return failure(
      503,
      "facilitator_transaction_pending",
      "The facilitator wallet is reconciling a prior transaction.",
      true,
    );
  }
  if (error instanceof FacilitatorTransactionTerminalError) {
    return failure(
      error.status === "nonce_conflict" ? 503 : 400,
      error.status === "nonce_conflict"
        ? "confirmation_reconciliation_required"
        : "submit_reverted",
      "The stored confirmation transaction reached a terminal failure.",
    );
  }
  if (error instanceof ConfirmationSubmitError) {
    if (error.stage === "validation") {
      return failure(
        400,
        error.needsFreshSignature
          ? "confirmation_signature_invalid"
          : "submit_rejected",
        publicErrorMessage(
          "runConfirmDelivery.validation",
          error,
          "confirmation was rejected before broadcast",
        ),
        !error.needsFreshSignature,
      );
    }
    if (error.stage === "reverted") {
      return failure(400, "submit_reverted", "The transaction was mined and reverted.");
    }
    return failure(
      503,
      "confirmation_reconciliation_pending",
      "The confirmation transaction is awaiting durable reconciliation.",
      true,
    );
  }
  return failure(
    500,
    "submit_failed",
    publicErrorMessage(
      "runConfirmDelivery.submit",
      error,
      "confirmation submission failed",
    ),
  );
}

function failure(
  status: number,
  code: string,
  message: string,
  retryable = false,
): ConfirmResult {
  return {
    ok: false,
    status,
    error: { code, message, ...(retryable ? { retryable: true } : {}) },
  };
}

function admissionMessage(code: string): string {
  const messages: Record<string, string> = {
    confirmation_signature_expiring:
      "The confirmation signature expires too soon; prepare and sign again.",
    confirmation_signature_invalid:
      "The confirmation signature is invalid; prepare and sign again.",
    unknown_payment: "No on-chain payment exists with this id.",
    confirmation_attester_mismatch:
      "The attester is not the buyer wallet recorded for this payment.",
    confirmation_reconciliation_pending:
      "A prior confirmation for this payment is awaiting reconciliation.",
    confirmation_nonce_stale:
      "The signed EAS nonce is no longer current; prepare and sign again.",
    confirmation_initial_has_ref:
      "An initial confirmation must not include refUid.",
    confirmation_revision_ref_required:
      "A confirmation revision must reference the current attestation.",
    confirmation_revision_stale:
      "The revision references an old confirmation attestation.",
    confirmation_revision_limit:
      "This payment has reached its confirmation revision limit.",
    confirmation_sponsorship_limited:
      "This wallet has reached its daily confirmation sponsorship limit.",
    confirmation_sponsorship_unavailable:
      "The daily confirmation sponsorship capacity is exhausted.",
  };
  return messages[code] ?? "Confirmation request rejected.";
}

export function createConfirmRouter(deps: ConfirmDeps): Router {
  const router = Router();
  router.post("/confirm/:paymentId", async (req: Request, res: Response) => {
    const result = await runConfirmDelivery(
      deps,
      String(req.params.paymentId),
      req.body,
    );
    if (
      !result.ok &&
      (result.error.code === "confirmation_sponsorship_limited" ||
        result.error.code === "confirmation_sponsorship_unavailable")
    ) {
      res.setHeader("Retry-After", secondsUntilUtcMidnight());
    }
    res.status(result.ok ? 200 : result.status).json(
      result.ok ? result : { error: result.error },
    );
  });
  return router;
}

function secondsUntilUtcMidnight(now = new Date()): string {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return String(Math.max(1, Math.min(86_400, Math.ceil((next - now.getTime()) / 1_000))));
}
