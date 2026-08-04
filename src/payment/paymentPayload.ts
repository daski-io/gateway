import type {
  DaskiPaymentPayload,
  Hex,
  PaymentPayload,
  StoredChallenge,
} from "../types.js";
import { isHex32 } from "../util/evmValidation.js";
import { getDaskiDeclaration } from "./x402Extension.js";

export type PaymentPayloadCorrelation =
  | { ok: true; serviceRef: Hex }
  | { ok: false; reason: "service_ref_missing" | "service_ref_mismatch" };

export function paymentPayloadCorrelation(
  payload: DaskiPaymentPayload,
): PaymentPayloadCorrelation {
  const explicit = isHex32(payload.serviceRef)
    ? (payload.serviceRef.toLowerCase() as Hex)
    : null;
  const declared = getDaskiDeclaration(payload)?.info.serviceRef;
  if (
    explicit &&
    declared &&
    explicit.toLowerCase() !== declared.toLowerCase()
  ) {
    return { ok: false, reason: "service_ref_mismatch" };
  }
  const serviceRef = explicit ?? declared;
  return serviceRef
    ? { ok: true, serviceRef: serviceRef.toLowerCase() as Hex }
    : { ok: false, reason: "service_ref_missing" };
}

export function materializePaymentPayload(
  payload: DaskiPaymentPayload,
  challenge: StoredChallenge,
): PaymentPayload | null {
  const paymentRequired = challenge.paymentRequired;
  const accepted = payload.accepted ?? paymentRequired?.accepts[0];
  if (
    payload.x402Version !== 2 ||
    !paymentRequired ||
    !accepted ||
    !payload.payload ||
    typeof payload.payload !== "object" ||
    Array.isArray(payload.payload)
  ) {
    return null;
  }
  return {
    x402Version: 2,
    resource: payload.resource ?? paymentRequired.resource,
    accepted,
    payload: payload.payload,
    extensions: payload.extensions ?? paymentRequired.extensions,
  };
}
