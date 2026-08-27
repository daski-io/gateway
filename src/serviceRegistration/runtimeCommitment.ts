import type { Address, Hex } from "viem";
import { canonicalHash } from "../standardRail/canonical.js";
import type {
  GatewayListingPreparationV1,
  GatewaySkillControlProfileV1,
} from "./types.js";
import type { SignedEnvelope } from "../standardRail/types.js";

/**
 * The immutable identity of one admitted listing version. Its canonical hash
 * is the `runtimeCommitmentHash` bound into every V2 order nonce, stored on
 * orders, and recomputed independently by the provider from its own copies of
 * the same artifacts — equality is the cross-check.
 *
 * Identity rules:
 * - The builder runs only for NEW admissions; a reused listing's persisted
 *   commitment is returned verbatim by callers and never reconstructed, so
 *   re-registering a changed sibling cannot rotate an unchanged skill.
 * - Paid listings derive identity from the ORIGINAL gateway preparation
 *   envelope (listing id, intent hash, economics). Service slug and version
 *   are not direct fields — they bind transitively through the provider
 *   intent, and the serviceId already fixes them.
 * - The CURRENT registration's linkage and deployment transaction hashes
 *   appear in no direct field; the original admission's registration id
 *   rides inside the referenced signed artifacts, fixed forever.
 * - Mutable state (availability, visibility, freshness, reputation,
 *   capacity utilization) is excluded, and the rail binding is the
 *   splitter-level policyVersionHash — never the facilitator profile.
 * - Every paid listing has its deployment artifacts regardless of
 *   availability; artifact presence must match the payment mode exactly.
 */
export interface RuntimeListingCommitmentV1 {
  artifactType: "RuntimeListingCommitmentV1";
  schemaVersion: 1;
  environment: string;
  chainId: number;
  gatewayAudience: string;
  listingId: string;
  listingKey: Hex;
  listingEpoch: string;
  providerAgentId: string;
  serviceId: Hex;
  skillId: string;
  skillContractHash: Hex;
  providerIntentHash: Hex;
  paymentRequired: boolean;
  /** canonicalHash of the signed listing preparation; equals the splitter's
   *  on-chain listingCommitmentHash. Null for free skills. */
  preparationHash: Hex | null;
  controlProfileHash: Hex | null;
  policyVersionHash: Hex;
  canonicalToken: Address;
  daskiCommissionReceiver: Address;
  commissionBps: number;
  providerPayee: Address;
  splitterFactory: Address | null;
  splitterAddress: Address | null;
}

export interface RuntimeCommitmentInputs {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  providerAgentId: string;
  serviceId: Hex;
  /** Intent hash of the CURRENT registration; used only for free skills
   *  without an original admission envelope of their own. */
  currentProviderIntentHash: Hex;
  currentProviderPayee: Address;
  policy: {
    canonicalToken: Address;
    daskiCommissionReceiver: Address;
    commissionBps: number;
    policyVersionHash: Hex;
    splitterFactory: Address;
  };
  listing: {
    listingId: string;
    listingKey: Hex;
    skillId: string;
    skillContractHash: Hex;
    paymentRequired: boolean;
    splitterAddress: Address | null;
    preparation: SignedEnvelope<GatewayListingPreparationV1> | null;
    controlProfile: SignedEnvelope<GatewaySkillControlProfileV1> | null;
  };
}

export function buildRuntimeListingCommitment(
  args: RuntimeCommitmentInputs,
): RuntimeListingCommitmentV1 {
  const envelope = args.listing.preparation ?? null;
  const preparation = envelope?.payload ?? null;
  const paid = args.listing.paymentRequired;
  if ((envelope !== null) !== paid || (args.listing.splitterAddress !== null) !== paid) {
    throw new Error("Listing deployment artifacts do not match its payment mode");
  }
  if (preparation && preparation.skillId !== args.listing.skillId) {
    throw new Error("Listing preparation does not describe this skill");
  }
  const controlProfile = args.listing.controlProfile?.payload ?? null;
  return {
    artifactType: "RuntimeListingCommitmentV1",
    schemaVersion: 1,
    environment: args.environment,
    chainId: args.chainId,
    gatewayAudience: args.gatewayAudience,
    listingId: preparation?.listingId ?? args.listing.listingId,
    listingKey: args.listing.listingKey,
    listingEpoch: preparation?.listingEpoch ?? "0",
    providerAgentId: args.providerAgentId,
    serviceId: args.serviceId,
    skillId: args.listing.skillId,
    skillContractHash: preparation?.skillContractHash ?? args.listing.skillContractHash,
    providerIntentHash: preparation?.providerIntentHash ??
      controlProfile?.providerIntentHash ??
      args.currentProviderIntentHash,
    paymentRequired: args.listing.paymentRequired,
    preparationHash: args.listing.preparation
      ? canonicalHash(args.listing.preparation)
      : null,
    controlProfileHash: args.listing.controlProfile
      ? canonicalHash(args.listing.controlProfile)
      : null,
    policyVersionHash: preparation?.policyVersionHash ?? args.policy.policyVersionHash,
    canonicalToken: preparation?.canonicalToken ?? args.policy.canonicalToken,
    daskiCommissionReceiver: preparation?.daskiCommissionReceiver ??
      args.policy.daskiCommissionReceiver,
    commissionBps: preparation?.commissionBps ?? args.policy.commissionBps,
    providerPayee: preparation?.providerPayee ?? args.currentProviderPayee,
    splitterFactory: preparation?.splitterFactory ??
      (args.listing.paymentRequired ? args.policy.splitterFactory : null),
    splitterAddress: args.listing.splitterAddress,
  };
}

export function runtimeCommitmentHash(commitment: RuntimeListingCommitmentV1): Hex {
  return canonicalHash(commitment);
}
