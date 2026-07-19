import { encodeAbiParameters, parseAbiParameters } from "viem";
import type { Config } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { Eip712TypedData, Hex } from "../types.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { CONFIRMATION_CODE } from "./protocol.js";

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

const ATTEST_TYPES = {
  Attest: [
    { name: "schema", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "expirationTime", type: "uint64" },
    { name: "revocable", type: "bool" },
    { name: "refUID", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

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
  if (
    typeof input.attester !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(input.attester)
  ) {
    return fail("BAD_ATTESTER", "attester must be a 20-byte hex address");
  }
  if (
    input.refUid != null &&
    (typeof input.refUid !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(input.refUid))
  ) {
    return fail("BAD_REFUID", "refUid must be a 32-byte hex string");
  }
  const deadlineSeconds =
    input.deadlineSeconds == null ? 3600 : Number(input.deadlineSeconds);
  if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds <= 0) {
    return fail(
      "BAD_DEADLINE",
      "deadlineSeconds must be a positive integer",
    );
  }

  const attester = input.attester.toLowerCase() as Hex;
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
  const typedData: Eip712TypedData = {
    domain: {
      name: "EAS",
      version: "1.2.0",
      chainId: deps.config.chainId,
      verifyingContract: deps.config.easAddress,
    },
    types: {
      Attest: ATTEST_TYPES.Attest.map((field) => ({
        name: field.name,
        type: field.type,
      })),
    },
    primaryType: "Attest",
    message: {
      schema: deps.config.easConfirmationSchemaUid,
      recipient: ZERO_ADDRESS,
      expirationTime: "0",
      revocable: true,
      refUID,
      data,
      value: "0",
      nonce: nonce.toString(),
      deadline: deadline.toString(),
    },
  };
  return {
    ok: true,
    value: {
      paymentId: paymentId.toString(),
      confirmation: input.confirmation,
      attester,
      deadline: deadline.toString(),
      refUid: input.refUid ?? null,
      eip712TypedData: typedData,
      submitTemplate: {
        confirmation: input.confirmation,
        attester,
        deadline: deadline.toString(),
        ...(input.refUid ? { refUid: input.refUid } : {}),
      },
    },
  };
}
