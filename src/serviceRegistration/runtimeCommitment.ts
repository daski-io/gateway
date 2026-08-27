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
 * - Paid listings derive every identity field from the ORIGINAL gateway
 *   preparation envelope (listing id, intent hash, slug/version, audience,
 *   economics), which reused listings retain verbatim — so re-registering a
 *   changed sibling skill can never rotate an unchanged skill's commitment.
 * - The CURRENT registration's linkage and deployment transaction hashes are
 *   operational, not identity, and appear in no direct field; the original
 *   admission's registration id still rides inside the referenced signed
 *   artifacts, which is fixed forever and therefore rotation-safe.
 * - Mutable state (visibility, freshness, reputation, capacity utilization)
 *   is excluded, and the rail binding is the splitter-level policyVersionHash
 *   — never the replaceable facilitator profile.
 * - The service contract and skill-set hashes are bound transitively through
 *   the provider intent referenced here.
 * - A paid listing with neither preparation nor splitter is a valid
 *   provider-controlled take-down; only a mixed state is rejected.
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
  serviceSlug: string;
  serviceVersion: string;
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
  serviceSlug: string;
  serviceVersion: string;
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
  // A paid listing either has both deployment artifacts (accepting orders)
  // or neither (a provider-controlled take-down); a mixed state is corrupt.
  if ((envelope === null) !== (args.listing.splitterAddress === null)) {
    throw new Error("Listing preparation and splitter address are inconsistent");
  }
  if (preparation && preparation.skillId !== args.listing.skillId) {
    throw new Error("Listing preparation does not describe this skill");
  }
  const controlProfile = args.listing.controlProfile?.payload ?? null;
  return {
    artifactType: "RuntimeListingCommitmentV1",
    schemaVersion: 1,
    environment: envelope?.environment ?? args.environment,
    chainId: envelope?.chainId ?? args.chainId,
    gatewayAudience: envelope?.audience ?? args.gatewayAudience,
    listingId: preparation?.listingId ?? args.listing.listingId,
    listingKey: args.listing.listingKey,
    listingEpoch: preparation?.listingEpoch ?? "0",
    providerAgentId: args.providerAgentId,
    serviceId: args.serviceId,
    serviceSlug: preparation?.serviceSlug ?? args.serviceSlug,
    serviceVersion: preparation?.serviceVersion ?? args.serviceVersion,
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
