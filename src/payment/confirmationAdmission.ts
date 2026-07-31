import { recoverTypedDataAddress } from "viem";
import type { Config } from "../config.js";
import type { ConfirmationSponsorshipLimit } from "../db/confirmationSubmissionTypes.js";
import type { Hex } from "../types.js";
import type { ConfirmInput } from "./confirmationRequest.js";
import { confirmationTypedData } from "./confirmationTypedData.js";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export class ConfirmationAdmissionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(code);
    this.name = "ConfirmationAdmissionError";
  }
}

export async function verifyConfirmationSignature(
  config: Config,
  input: ConfirmInput,
  recipient: Hex,
  refUid: Hex,
  data: Hex,
): Promise<void> {
  try {
    const typedData = confirmationTypedData(config, {
      recipient,
      refUid,
      data,
      easNonce: input.easNonce,
      deadline: input.deadline,
    });
    const recovered = await recoverTypedDataAddress({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: "Attest",
      message: typedData.message,
      signature: {
        r: input.signature.r,
        s: input.signature.s,
        yParity: input.signature.v - 27,
      },
    });
    if (recovered.toLowerCase() !== input.attester.toLowerCase()) {
      throw new Error("confirmation signature signer mismatch");
    }
  } catch {
    throw new ConfirmationAdmissionError(
      "confirmation_signature_invalid",
      400,
    );
  }
}

export function validateConfirmationRevision(
  currentUid: Hex,
  input: ConfirmInput,
): void {
  if (currentUid.toLowerCase() === ZERO_BYTES32) {
    if (input.refUid) {
      throw new ConfirmationAdmissionError("confirmation_initial_has_ref", 409);
    }
    return;
  }
  if (!input.refUid) {
    throw new ConfirmationAdmissionError(
      "confirmation_revision_ref_required",
      409,
    );
  }
  if (input.refUid.toLowerCase() !== currentUid.toLowerCase()) {
    throw new ConfirmationAdmissionError("confirmation_revision_stale", 409);
  }
}

export function confirmationSponsorshipError(
  limit: ConfirmationSponsorshipLimit,
): ConfirmationAdmissionError {
  if (limit === "payment") {
    return new ConfirmationAdmissionError("confirmation_revision_limit", 409);
  }
  if (limit === "wallet") {
    return new ConfirmationAdmissionError(
      "confirmation_sponsorship_limited",
      429,
      true,
    );
  }
  return new ConfirmationAdmissionError(
    "confirmation_sponsorship_unavailable",
    503,
    true,
  );
}
