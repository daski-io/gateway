import { encodeAbiParameters, parseAbiParameters } from "viem";
import type { Config } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { Eip712TypedData, Hex } from "../types.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { isHex32, isHexAddress } from "../util/evmValidation.js";
import { CONFIRMATION_CODE } from "./protocol.js";
import { confirmationTypedData } from "./confirmationTypedData.js";

export interface ConfirmationPrepDeps {
  config: Config;
  reader: ChainReader;
}

export type ConfirmationPrepResult =
  | { ok: true; value: Record<string, unknown> }
  | {
      ok: false;
      status: number;
      error: { code: string; message: string; correlationId?: string };
    };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const PAYLOAD_TYPES = parseAbiParameters(
  "uint256 paymentId, uint8 confirmation",
);
function fail(
  code: string,
  message: string,
  status = 400,
): ConfirmationPrepResult {
  return { ok: false, status, error: { code, message } };
}

export async function prepareConfirmation(
  deps: ConfirmationPrepDeps,
  input: {
    paymentId: unknown;
    confirmation: unknown;
    attester: unknown;
    deadlineSeconds?: unknown;
    refUid?: unknown;
  },
  now = new Date(),
): Promise<ConfirmationPrepResult> {
  let paymentId: bigint;
  try {
    paymentId = BigInt(String(input.paymentId));
  } catch {
    return fail("BAD_PAYMENT_ID", "paymentId must be numeric");
  }
  if (
    input.confirmation !== "Confirmed" &&
    input.confirmation !== "NotConfirmed"
  ) {
    return fail(
      "BAD_CONFIRMATION",
      'confirmation must be "Confirmed" or "NotConfirmed"',
    );
  }
  if (!isHexAddress(input.attester)) {
    return fail("BAD_ATTESTER", "attester must be a 20-byte hex address");
  }
  if (
    input.refUid != null &&
    !isHex32(input.refUid)
  ) {
    return fail("BAD_REFUID", "refUid must be a 32-byte hex string");
  }
  const requestedDeadlineSeconds =
    input.deadlineSeconds == null ? 3600 : Number(input.deadlineSeconds);
  if (
    !Number.isSafeInteger(requestedDeadlineSeconds) ||
    requestedDeadlineSeconds <= 0
  ) {
    return fail(
      "BAD_DEADLINE",
      "deadlineSeconds must be a positive integer",
    );
  }
  const deadlineSeconds = Math.min(
    3_600,
    Math.max(300, requestedDeadlineSeconds),
  );

  const attester = input.attester.toLowerCase() as Hex;

  // v0.6.0 resolver rule: confirmation attestations must name the payment's
  // cached provider wallet (falling back to the cached owner) as recipient —
  // a zero recipient reverts with "wrong reputation recipient".
  let recipient: Hex;
  try {
    const record = await deps.reader.getPaymentRecord(paymentId);
    if (!record) {
      return fail("UNKNOWN_PAYMENT", "no on-chain payment with this id");
    }
    recipient =
      record.cachedProviderWallet !== ZERO_ADDRESS
        ? record.cachedProviderWallet
        : record.cachedProviderOwner;
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: {
        code: "CHAIN_READ_FAILED",
        message: "chain read failed",
        correlationId: logErrorWithId("prepareConfirmation.payment", err),
      },
    };
  }

  let nonce: bigint;
  try {
    nonce = await deps.reader.getEasAttesterNonce(attester);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: {
        code: "CHAIN_READ_FAILED",
        message: "chain read failed",
        correlationId: logErrorWithId("prepareConfirmation.nonce", err),
      },
    };
  }

  const deadline =
    BigInt(Math.floor(now.getTime() / 1000)) + BigInt(deadlineSeconds);
  const refUID = (input.refUid ?? ZERO_BYTES32) as Hex;
  const data = encodeAbiParameters(PAYLOAD_TYPES, [
    paymentId,
    CONFIRMATION_CODE[input.confirmation],
  ]);
  const typedData: Eip712TypedData = confirmationTypedData(deps.config, {
    recipient,
    refUid: refUID,
    data,
    easNonce: nonce,
    deadline,
  });
  return {
    ok: true,
    value: {
      paymentId: paymentId.toString(),
      confirmation: input.confirmation,
      attester,
      deadline: deadline.toString(),
      easNonce: nonce.toString(),
      refUid: input.refUid ?? null,
      eip712TypedData: typedData,
      submitTemplate: {
        confirmation: input.confirmation,
        attester,
        deadline: deadline.toString(),
        easNonce: nonce.toString(),
        ...(input.refUid ? { refUid: input.refUid } : {}),
      },
    },
  };
}
