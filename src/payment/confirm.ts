import { Router, type Request, type Response } from "express";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import type { Config } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { Queries } from "../db/queries.js";
import type { Hex } from "../types.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import { logErrorWithId, publicErrorMessage } from "../util/errorWrap.js";
import {
  CONFIRMATION_CODE,
  isHex32,
  isHexAddress,
  type ConfirmationLabel,
} from "./protocol.js";

export interface ConfirmDeps {
  config: Config;
  reader: ChainReader;
  queries: Queries;
  reputationWorker: ReputationMirrorWorker;
}

// ReputationStorage.sol BuyerConfirmation enum values. Keep these in lock-step
// with the Solidity enum order (0=Pending, 1=Confirmed, 2=NotConfirmed) —
// the resolver rejects Pending attestations outright.
const CONFIRMATION_PAYLOAD_TYPES = parseAbiParameters(
  "uint256 paymentId, uint8 confirmation",
);

const BYTES32_ZERO: Hex = ("0x" + "00".repeat(32)) as Hex;

// ── Input validation ─────────────────────────────────────────────────────

export interface ConfirmInput {
  confirmation: ConfirmationLabel;
  attester: Hex;
  deadline: string | number;
  refUid?: Hex;
  signature: { v: number; r: Hex; s: Hex };
}

export type ConfirmResult =
  | {
      ok: true;
      paymentId: string;
      confirmation: ConfirmationLabel;
      attestationUid: Hex;
      transactionHash: Hex;
      refUid: Hex | null;
    }
  | {
      ok: false;
      status: number;
      error: { code: string; message: string };
    };

function parseInput(body: unknown): ConfirmInput | { ok: false; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (b.confirmation !== "Confirmed" && b.confirmation !== "NotConfirmed") {
    return {
      ok: false,
      message: "confirmation must be \"Confirmed\" or \"NotConfirmed\"",
    };
  }
  if (!isHexAddress(b.attester)) {
    return { ok: false, message: "attester must be a 20-byte hex address" };
  }
  if (typeof b.deadline === "string") {
    if (!/^[1-9][0-9]*$/.test(b.deadline)) {
      return {
        ok: false,
        message: "deadline string must be a positive decimal integer",
      };
    }
  } else if (typeof b.deadline === "number") {
    if (!Number.isInteger(b.deadline) || b.deadline <= 0) {
      return { ok: false, message: "deadline number must be a positive integer" };
    }
  } else {
    return { ok: false, message: "deadline must be a decimal string or number" };
  }
  if (b.refUid !== undefined && !isHex32(b.refUid)) {
    return { ok: false, message: "refUid, when provided, must be a 32-byte hex string" };
  }
  if (!b.signature || typeof b.signature !== "object") {
    return { ok: false, message: "signature is required" };
  }
  const sig = b.signature as Record<string, unknown>;
  if (typeof sig.v !== "number" || sig.v < 0 || sig.v > 255) {
    return { ok: false, message: "signature.v must be a uint8" };
  }
  if (!isHex32(sig.r) || !isHex32(sig.s)) {
    return { ok: false, message: "signature.r and signature.s must each be 32-byte hex" };
  }

  return {
    confirmation: b.confirmation,
    attester: b.attester,
    deadline: b.deadline as string | number,
    refUid: (b.refUid as Hex | undefined),
    signature: { v: sig.v, r: sig.r, s: sig.s },
  };
}

// ── Core runner ──────────────────────────────────────────────────────────

export async function runConfirmDelivery(
  deps: ConfirmDeps,
  paymentIdStr: string,
  body: unknown,
): Promise<ConfirmResult> {
  let paymentId: bigint;
  try {
    paymentId = BigInt(paymentIdStr);
  } catch {
    return {
      ok: false,
      status: 400,
      error: { code: "bad_payment_id", message: "paymentId must be a numeric string" },
    };
  }

  const parsed = parseInput(body);
  if ("ok" in parsed && parsed.ok === false) {
    return {
      ok: false,
      status: 400,
      error: { code: "bad_input", message: parsed.message },
    };
  }
  const input = parsed as ConfirmInput;

  const confirmationCode = CONFIRMATION_CODE[input.confirmation];
  const payload = encodeAbiParameters(CONFIRMATION_PAYLOAD_TYPES, [
    paymentId,
    confirmationCode,
  ]);

  // BigInt() throws on non-numeric strings or fractional numbers; previously
  // this lived outside the try/catch and crashed the route. parseInput
  // already validates the shape, but BigInt is allergic to anything
  // non-decimal so we keep the conversion inside the protected scope.
  let deadlineBig: bigint;
  try {
    deadlineBig =
      typeof input.deadline === "number"
        ? BigInt(input.deadline)
        : BigInt(input.deadline);
  } catch {
    return {
      ok: false,
      status: 400,
      error: {
        code: "bad_input",
        message: "deadline could not be parsed as an integer",
      },
    };
  }

  // Must match the recipient the buyer signed over in prepareConfirmation:
  // the payment's cached provider wallet (owner fallback) per the v0.6.0
  // resolver's "wrong reputation recipient" rule.
  let confirmationRecipient: Hex;
  try {
    const record = await deps.reader.getPaymentRecord(paymentId);
    if (!record) {
      return {
        ok: false,
        status: 404,
        error: { code: "unknown_payment", message: "no on-chain payment with this id" },
      };
    }
    confirmationRecipient =
      record.cachedProviderWallet !== ("0x" + "00".repeat(20))
        ? record.cachedProviderWallet
        : record.cachedProviderOwner;
  } catch (err) {
    logErrorWithId("confirm.paymentRecord", err);
    return {
      ok: false,
      status: 502,
      error: { code: "chain_read_failed", message: "chain read failed" },
    };
  }

  try {
    const result = await deps.queries.withFacilitatorTransactionLock(
      (release) =>
        deps.reader.submitBuyerConfirmation(
          {
            attester: input.attester,
            schema: deps.config.easConfirmationSchemaUid,
            recipient: confirmationRecipient,
            expirationTime: 0n,
            revocable: true,
            refUID: input.refUid ?? BYTES32_ZERO,
            data: payload,
            value: 0n,
            deadline: deadlineBig,
            signature: {
              v: input.signature.v,
              r: input.signature.r,
              s: input.signature.s,
            },
          },
          release,
        ),
    );

    // Best-effort persist the UID on the matching challenge row. Failure
    // doesn't invalidate the on-chain attestation (EAS is canonical), so
    // we don't propagate the error to the caller — they got their UID in
    // the response. Worst case the public activity feed deep-link to EAS
    // shows null for this row until the next confirmation revises it.
    try {
      await deps.queries.recordConfirmation(paymentId, result.attestationUid);
    } catch (error) {
      logErrorWithId("confirmation.record", error);
    }

    // Mirror the confirmation as public ERC-8004 feedback for the provider
    // on the canonical ReputationRegistry (facilitator wallet = the
    // orchestrator-client, EAS attestation = evidence). Fire-and-forget:
    // the mirror must NEVER delay or fail the buyer's confirmation
    // response. The durable worker handles its own bookkeeping and logging; the
    // catch here only guards against bugs in the mirror itself.
    void deps.reputationWorker.enqueue({
      paymentId,
      confirmation: input.confirmation,
      attestationUid: result.attestationUid,
      refUid: input.refUid ?? null,
    }).catch((err) => {
      logErrorWithId("reputationMirror.unhandled", err);
    });

    return {
      ok: true,
      paymentId: paymentId.toString(),
      confirmation: input.confirmation,
      attestationUid: result.attestationUid,
      transactionHash: result.transactionHash,
      refUid: input.refUid ?? null,
    };
  } catch (err) {
    // EAS reverts on signature invalid / nonce mismatch / deadline expired;
    // the resolver reverts on unauthorized attester / duplicate confirmation
    // without refUID. All of these surface as a chain-level reverted call.
    return {
      ok: false,
      status: 400,
      error: {
        code: "submit_failed",
        message: publicErrorMessage(
          "runConfirmDelivery.submit",
          err,
          "confirmation submission failed",
        ),
      },
    };
  }
}

// ── REST router ──────────────────────────────────────────────────────────

export function createConfirmRouter(deps: ConfirmDeps): Router {
  const router = Router();

  router.post("/confirm/:paymentId", async (req: Request, res: Response) => {
    const result = await runConfirmDelivery(deps, String(req.params.paymentId), req.body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(200).json(result);
  });

  return router;
}
