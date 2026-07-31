import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../../src/config.js";
import {
  confirmationPayload,
  type ConfirmInput,
} from "../../src/payment/confirmationRequest.js";
import { confirmationTypedData } from "../../src/payment/confirmationTypedData.js";
import type { Hex } from "../../src/types.js";

const TEST_BUYER_PRIVATE_KEY =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

export const TEST_BUYER_ACCOUNT = privateKeyToAccount(TEST_BUYER_PRIVATE_KEY);
export const TEST_BUYER = TEST_BUYER_ACCOUNT.address;

export async function signedConfirmation(
  config: Pick<
    Config,
    "chainId" | "easAddress" | "easConfirmationSchemaUid"
  >,
  input: {
    paymentId: bigint;
    confirmation: ConfirmInput["confirmation"];
    recipient: Hex;
    easNonce?: bigint;
    deadline?: bigint;
    refUid?: Hex | null;
  },
): Promise<Record<string, unknown>> {
  const easNonce = input.easNonce ?? 0n;
  const deadline =
    input.deadline ?? BigInt(Math.floor(Date.now() / 1_000) + 3_600);
  const refUid = input.refUid ?? (`0x${"00".repeat(32)}` as Hex);
  const data = confirmationPayload(input.paymentId, input.confirmation);
  const typedData = confirmationTypedData(config, {
    recipient: input.recipient,
    refUid,
    data,
    easNonce,
    deadline,
  });
  const encoded = await TEST_BUYER_ACCOUNT.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: "Attest",
    message: typedData.message,
  });
  const encodedV = Number.parseInt(encoded.slice(130, 132), 16);
  return {
    confirmation: input.confirmation,
    attester: TEST_BUYER,
    easNonce: easNonce.toString(),
    deadline: deadline.toString(),
    ...(input.refUid ? { refUid: input.refUid } : {}),
    signature: {
      r: `0x${encoded.slice(2, 66)}`,
      s: `0x${encoded.slice(66, 130)}`,
      v: encodedV < 27 ? encodedV + 27 : encodedV,
    },
  };
}
