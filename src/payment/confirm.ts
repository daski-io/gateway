import { Router, type Request, type Response } from "express";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import type { Config } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { Queries } from "../db/queries.js";
import type { Hex } from "../types.js";

export interface ConfirmDeps {
  config: Config;
  reader: ChainReader;
  queries: Queries;
}

// ReputationStorage.sol BuyerConfirmation enum values. Keep these in lock-step
// with the Solidity enum order (0=Pending, 1=Confirmed, 2=NotConfirmed) —
// the resolver rejects Pending attestations outright.
const CONFIRMATION_CODE = {
  Confirmed: 1,
  NotConfirmed: 2,
} as const;
type ConfirmationLabel = keyof typeof CONFIRMATION_CODE;

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

function isHexAddress(x: unknown): x is Hex {
  return typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
}

function isHex32(x: unknown): x is Hex {
  return typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
}

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
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: {
        code: "bad_input",
        message: `deadline could not be parsed as bigint: ${(err as Error).message}`,
      },
    };
  }

  try {
    const result = await deps.reader.submitBuyerConfirmation({
      attester: input.attester,
      schema: deps.config.easConfirmationSchemaUid,
      recipient: ("0x" + "00".repeat(20)) as Hex,
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
    });

    // Best-effort persist the UID on the matching challenge row. Failure
    // doesn't invalidate the on-chain attestation (EAS is canonical), so
    // we don't propagate the error to the caller — they got their UID in
    // the response. Worst case the public activity feed deep-link to EAS
    // shows null for this row until the next confirmation revises it.
    try {
      await deps.queries.recordConfirmation(paymentId, result.attestationUid);
    } catch {
      // Swallow — see comment above.
    }

    return {
      ok: true,
      paymentId: paymentId.toString(),
      confirmation: input.confirmation,
      attestationUid: result.attestationUid,
      transactionHash: result.transactionHash,
      refUid: input.refUid ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // EAS reverts on signature invalid / nonce mismatch / deadline expired;
    // the resolver reverts on unauthorized attester / duplicate confirmation
    // without refUID. All of these surface as a chain-level reverted call.
    return {
      ok: false,
      status: 400,
      error: { code: "submit_failed", message },
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
