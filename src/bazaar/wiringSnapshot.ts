import type {
  BazaarCompatibilityWiring,
  BazaarListing,
} from "./types.js";

export function snapshotBazaarCompatibilityWiring(
  wiring: BazaarCompatibilityWiring,
): BazaarCompatibilityWiring {
  const facilitator = wiring.facilitator;
  const evidenceVerifier = wiring.evidenceVerifier;
  const payerProfileVerifier = wiring.payerProfileVerifier;
  const fulfillment = wiring.fulfillment;
  const signingBroker = wiring.providerActionSigningBroker;
  return {
    ...wiring,
    listings: wiring.listings.map(snapshotListing),
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
    facilitator: {
      verify: facilitator.verify.bind(facilitator),
      settle: facilitator.settle.bind(facilitator),
    },
    evidenceVerifier: {
      verify: evidenceVerifier.verify.bind(evidenceVerifier),
    },
    payerProfileVerifier: {
      verifyBeforeSettlement: payerProfileVerifier.verifyBeforeSettlement.bind(
        payerProfileVerifier,
      ),
    },
    fulfillment: {
      dispatch: fulfillment.dispatch.bind(fulfillment),
      performLifecycleAction: fulfillment.performLifecycleAction.bind(fulfillment),
    },
    providerActionSigningBroker: {
      address: signingBroker.address,
      signLifecycleAction: signingBroker.signLifecycleAction.bind(signingBroker),
    },
  };
}

function snapshotListing(listing: BazaarListing): BazaarListing {
  return {
    ...listing,
    requestSchema: cloneJsonObject(listing.requestSchema),
    responseSchema: cloneJsonObject(listing.responseSchema),
    payToControlProof: { ...listing.payToControlProof },
    offer: {
      signature: listing.offer.signature,
      message: { ...listing.offer.message },
    },
  };
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
