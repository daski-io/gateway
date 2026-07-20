import type { Config } from "../config.js";
import type { Hex } from "../types.js";
import {
  decodeBazaarPayment,
  type BazaarPayment,
} from "./bazaarPayment.js";

export type BazaarAuthorizationResult =
  | {
      ok: true;
      core: BazaarPayment;
      from: Hex;
      authNonce: Hex;
      value: bigint;
      validAfter: bigint;
      validBefore: bigint;
    }
  | { ok: false; status: number; error: string };

export type ParsedBazaarAuthorization = Extract<
  BazaarAuthorizationResult,
  { ok: true }
>;

export function parseBazaarAuthorization(
  paymentHeader: string,
  config: Config,
): BazaarAuthorizationResult {
  const core = decodeBazaarPayment(paymentHeader);
  if (!core) {
    return failure(
      "payment header is not base64-encoded x402 v2 JSON with an " +
        "exact-scheme EVM authorization",
    );
  }
  const auth = core.authorization;
  if (auth.to.toLowerCase() !== config.paymentRouterAddress.toLowerCase()) {
    return failure(
      "authorization `to` must be the advertised payTo (PaymentRouter)",
    );
  }
  let value: bigint;
  try {
    value = BigInt(auth.value);
  } catch {
    return failure("authorization value must be a decimal string");
  }
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    validAfter = BigInt(auth.validAfter);
    validBefore = BigInt(auth.validBefore);
  } catch {
    return failure("authorization time bounds must be decimal strings");
  }
  return {
    ok: true,
    core,
    from: auth.from.toLowerCase() as Hex,
    authNonce: auth.nonce.toLowerCase() as Hex,
    value,
    validAfter,
    validBefore,
  };
}

function failure(error: string): BazaarAuthorizationResult {
  return { ok: false, status: 400, error };
}
