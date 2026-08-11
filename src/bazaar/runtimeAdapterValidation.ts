import { isHex32 } from "../util/evmValidation.js";
import type {
  BazaarCompatibilityWiring,
  BazaarRuntimeAdapter,
} from "./types.js";

export function validateBazaarRuntimeAdapterIdentities(
  wiring: BazaarCompatibilityWiring,
): void {
  const identities = [
    wiring.runtimeIdentity,
    wiring.providerAuthorityIdentity,
    wiring.facilitator.identity,
    wiring.evidenceVerifier.identity,
    wiring.settlementObserver.identity,
    wiring.payerProfileVerifier.identity,
    wiring.fulfillment.identity,
    wiring.fulfillmentObserver.identity,
    wiring.providerActionSigningBroker.identity,
    wiring.refundInstructionSigningBroker.identity,
    wiring.refundRequestService.identity,
    wiring.refundEvidenceVerifier.identity,
  ];
  for (const identity of identities) validateAdapterIdentity(identity);
}

function validateAdapterIdentity(
  identity: BazaarRuntimeAdapter["identity"] | undefined,
): void {
  if (
    !identity || typeof identity !== "object" ||
    Object.keys(identity).sort().join("\0") !==
      ["artifactHash", "authorityEpoch", "configurationHash"].sort().join("\0") ||
    !isNonzeroHex32(identity.artifactHash) ||
    !isNonzeroHex32(identity.configurationHash) ||
    typeof identity.authorityEpoch !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(identity.authorityEpoch)
  ) throw new Error("Bazaar runtime adapter identity is invalid");
}

function isNonzeroHex32(value: unknown): boolean {
  return isHex32(value) && value.toLowerCase() !== `0x${"00".repeat(32)}`;
}
