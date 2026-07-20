import { hexToBytes, recoverTypedDataAddress, type Address } from "viem";
import type { PaymentChainGateway } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Hex } from "../types.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import {
  isHex32,
  isHexAddress,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "./protocol.js";
import { missingQuoteCommitment } from "./settlementResults.js";
import type { SettleInput, VerifyResult } from "./verifyTypes.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
const VALID_BEFORE_BUFFER_SEC = 10n;

export async function verifyPaymentPayload(
  input: SettleInput,
  config: Config,
  reader: Pick<PaymentChainGateway, "authorizationUsed">,
  now: Date = new Date(),
  options: { allowBroadcastRecovery?: boolean } = {},
): Promise<VerifyResult> {
  const { payload, challenge } = input;
  const missingQuote = missingQuoteCommitment(challenge);
  if (missingQuote) {
    return fail(
      409,
      "quote_commitment_missing",
      `stored challenge is missing provider quote commitment fields: ${missingQuote}`,
    );
  }
  if (payload.x402Version !== 1) {
    return fail(400, "invalid_x402_version", `unsupported x402Version: ${payload.x402Version}`);
  }
  if (payload.scheme !== "exact") {
    return fail(400, "invalid_scheme", `unsupported scheme: ${payload.scheme}`);
  }
  if (payload.network !== config.network) {
    return fail(
      400,
      "invalid_network",
      `expected network ${config.network}, got ${payload.network}`,
    );
  }

  const auth = payload.payload?.authorization;
  const signature = payload.payload?.signature;
  if (!auth || !signature) {
    return fail(400, "invalid_payload", "missing authorization or signature");
  }
  if (
    !isHexAddress(auth.from) ||
    !isHexAddress(auth.to) ||
    !isHex32(auth.nonce) ||
    typeof auth.value !== "string" ||
    typeof auth.validAfter !== "string" ||
    typeof auth.validBefore !== "string"
  ) {
    return fail(400, "invalid_payload", "malformed authorization fields");
  }
  const payer = auth.from.toLowerCase() as Hex;
  let value: bigint;
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    value = BigInt(auth.value);
    validAfter = BigInt(auth.validAfter);
    validBefore = BigInt(auth.validBefore);
  } catch {
    return fail(
      400,
      "invalid_payload",
      "authorization numeric fields must be decimal strings",
      payer,
    );
  }
  const bindingFailure = validateAuthorizationBinding(
    value,
    auth.from,
    auth.to,
    challenge.amount,
    challenge.walletAddress,
    config.paymentRouterAddress,
  );
  if (bindingFailure) return fail(402, ...bindingFailure, payer);

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: config.usdcName,
        version: config.usdcVersion,
        chainId: config.chainId,
        verifyingContract: config.usdcAddress,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value,
        validAfter,
        validBefore,
        nonce: auth.nonce,
      },
      signature: signature as Hex,
    });
  } catch (error) {
    return fail(
      402,
      "invalid_exact_evm_payload_signature",
      publicErrorMessage(
        "verifyPaymentPayload.recoverSignature",
        error,
        "signature recovery failed",
      ),
      payer,
    );
  }
  if (recovered.toLowerCase() !== payer) {
    return fail(
      402,
      "invalid_exact_evm_payload_signature",
      "recovered signer does not match authorization.from",
      payer,
    );
  }
  let signatureParts: { v: number; r: Hex; s: Hex };
  try {
    signatureParts = parseSignature(signature as Hex);
  } catch {
    return fail(400, "invalid_payload", "malformed signature", payer);
  }
  const success = (): VerifyResult => ({
    ok: true,
    alreadyPaid: challenge.settlementState === "paid",
    payer,
    settleArgs: {
      ...signatureParts,
      validAfter,
      validBefore,
      nonce: auth.nonce,
    },
  });
  if (challenge.settlementState === "paid") return success();
  if (options.allowBroadcastRecovery && challenge.transactionHash) return success();
  if (challenge.settlementState === "expired" || challenge.expiresAt < now) {
    return fail(410, "authorization_expired", "the payment challenge has expired", payer);
  }
  const nowSec = BigInt(Math.floor(now.getTime() / 1000));
  if (validAfter >= nowSec) {
    return fail(
      402,
      "invalid_exact_evm_payload_authorization_valid_after",
      "authorization is not yet valid",
      payer,
    );
  }
  if (validBefore <= nowSec + VALID_BEFORE_BUFFER_SEC) {
    return fail(
      402,
      "invalid_exact_evm_payload_authorization_valid_before",
      "authorization is expired or too close to expiry",
      payer,
    );
  }
  try {
    if (await reader.authorizationUsed(payer, auth.nonce)) {
      return fail(
        402,
        "invalid_exact_evm_payload_authorization",
        "EIP-3009 nonce already consumed",
        payer,
      );
    }
  } catch (error) {
    return fail(
      503,
      "rpc_unavailable",
      publicErrorMessage(
        "verifyPaymentPayload.authorizationUsed",
        error,
        "unable to verify authorization nonce",
      ),
      payer,
    );
  }
  return success();
}

function validateAuthorizationBinding(
  value: bigint,
  from: Hex,
  to: Hex,
  expectedAmount: bigint,
  expectedWallet: Hex,
  expectedRecipient: Hex,
): [string, string] | null {
  if (value !== expectedAmount) {
    return [
      "invalid_exact_evm_payload_authorization_value",
      `authorization value ${value} does not match required ${expectedAmount}`,
    ];
  }
  if (to.toLowerCase() !== expectedRecipient.toLowerCase()) {
    return [
      "invalid_exact_evm_payload_recipient_mismatch",
      "authorization `to` must be the PaymentRouter",
    ];
  }
  if (from.toLowerCase() !== expectedWallet.toLowerCase()) {
    return [
      "invalid_exact_evm_payload_authorization_from",
      "authorization `from` does not match the wallet bound to this challenge",
    ];
  }
  return null;
}

function parseSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const bytes = hexToBytes(signature);
  if (bytes.length !== 65) throw new Error("signature must be 65 bytes");
  const r = `0x${Buffer.from(bytes.slice(0, 32)).toString("hex")}` as Hex;
  const s = `0x${Buffer.from(bytes.slice(32, 64)).toString("hex")}` as Hex;
  let v = bytes[64];
  if (v < 27) v += 27;
  return { v, r, s };
}

function fail(
  status: number,
  errorReason: string,
  message: string,
  payer: Hex = ZERO_ADDRESS,
): VerifyResult {
  return { ok: false, status, errorReason, message, payer };
}
