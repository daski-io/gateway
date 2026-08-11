import type {
  BazaarCompatibilityWiring,
  BazaarListing,
} from "./types.js";

export function snapshotBazaarCompatibilityWiring(
  wiring: BazaarCompatibilityWiring,
): BazaarCompatibilityWiring {
  const facilitator = wiring.facilitator;
  const evidenceVerifier = wiring.evidenceVerifier;
  const settlementObserver = wiring.settlementObserver;
  const payerProfileVerifier = wiring.payerProfileVerifier;
  const fulfillment = wiring.fulfillment;
  const fulfillmentObserver = wiring.fulfillmentObserver;
  const signingBroker = wiring.providerActionSigningBroker;
  const refundSigningBroker = wiring.refundInstructionSigningBroker;
  const refundRequestService = wiring.refundRequestService;
  const refundEvidenceVerifier = wiring.refundEvidenceVerifier;
  return {
    ...wiring,
    runtimeManifestApproval: { ...wiring.runtimeManifestApproval },
    runtimeIdentity: { ...wiring.runtimeIdentity },
    providerAuthorityIdentity: { ...wiring.providerAuthorityIdentity },
    adapterCallTimeoutMs: wiring.adapterCallTimeoutMs,
    listings: wiring.listings.map(snapshotListing),
    recoveryListings: wiring.recoveryListings.map(snapshotListing),
    retiredLifecycleCommitments: [...wiring.retiredLifecycleCommitments],
    approvedTermsOrigins: [...wiring.approvedTermsOrigins],
    challengeMac: {
      current: {
        epoch: wiring.challengeMac.current.epoch,
        secret: Buffer.from(wiring.challengeMac.current.secret),
      },
      ...(wiring.challengeMac.retained
        ? {
            retained: wiring.challengeMac.retained.map((key) => ({
              epoch: key.epoch,
              secret: Buffer.from(key.secret),
              acceptUntil: key.acceptUntil,
            })),
          }
        : {}),
    },
    settlementCapacity: { ...wiring.settlementCapacity },
    settlementObservationPolicy: { ...wiring.settlementObservationPolicy },
    fulfillmentObservationPolicy: { ...wiring.fulfillmentObservationPolicy },
    refundWorkerPolicy: { ...wiring.refundWorkerPolicy },
    refundRiskPolicies: Object.fromEntries(Object.entries(
      wiring.refundRiskPolicies,
    ).map(([providerId, policy]) => [providerId, { ...policy }])),
    facilitator: {
      identity: { ...facilitator.identity },
      verify: facilitator.verify.bind(facilitator),
      settle: facilitator.settle.bind(facilitator),
    },
    evidenceVerifier: {
      identity: { ...evidenceVerifier.identity },
      verify: evidenceVerifier.verify.bind(evidenceVerifier),
    },
    settlementObserver: {
      identity: { ...settlementObserver.identity },
      observe: settlementObserver.observe.bind(settlementObserver),
    },
    payerProfileVerifier: {
      identity: { ...payerProfileVerifier.identity },
      verifyBeforeSettlement: payerProfileVerifier.verifyBeforeSettlement.bind(
        payerProfileVerifier,
      ),
    },
    fulfillment: {
      identity: { ...fulfillment.identity },
      dispatch: fulfillment.dispatch.bind(fulfillment),
      performLifecycleAction: fulfillment.performLifecycleAction.bind(fulfillment),
    },
    fulfillmentObserver: {
      identity: { ...fulfillmentObserver.identity },
      observe: fulfillmentObserver.observe.bind(fulfillmentObserver),
    },
    providerActionSigningBroker: {
      address: signingBroker.address,
      identity: { ...signingBroker.identity },
      signLifecycleAction: signingBroker.signLifecycleAction.bind(signingBroker),
    },
    refundInstructionSigningBroker: {
      address: refundSigningBroker.address,
      identity: { ...refundSigningBroker.identity },
      signRefundInstruction: refundSigningBroker.signRefundInstruction.bind(
        refundSigningBroker,
      ),
    },
    refundRequestService: {
      identity: { ...refundRequestService.identity },
      requestRefund: refundRequestService.requestRefund.bind(refundRequestService),
    },
    refundEvidenceVerifier: {
      identity: { ...refundEvidenceVerifier.identity },
      verify: refundEvidenceVerifier.verify.bind(refundEvidenceVerifier),
    },
  };
}

function snapshotListing(listing: BazaarListing): BazaarListing {
  return {
    ...listing,
    requestSchema: cloneJsonObject(listing.requestSchema),
    responseSchema: cloneJsonObject(listing.responseSchema),
    payToControlProof: { ...listing.payToControlProof },
    fulfillmentSignerControlProof: { ...listing.fulfillmentSignerControlProof },
    offer: {
      signature: listing.offer.signature,
      message: { ...listing.offer.message },
    },
  };
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
