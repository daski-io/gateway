import type { SettleResponse } from "@x402/core/types";
import { keccak256, toBytes, type Hex } from "viem";
import {
  existingOutcomeResult,
  failureOutcome,
  successOutcome,
  type BazaarOutcomeResult,
} from "./outcomeHelpers.js";
import type { BazaarOrderStore } from "./store.js";
import type { BazaarLeaseGuard } from "./lease.js";
import type {
  BazaarCompatibilityWiring,
  BazaarListing,
  BazaarOrder,
} from "./types.js";

export async function dispatchBazaarOrder(input: {
  order: BazaarOrder;
  paymentResponse: SettleResponse;
  store: BazaarOrderStore;
  wiring: BazaarCompatibilityWiring;
  listing: BazaarListing;
  leaseToken: string;
  assertListingCurrent: () => Promise<void>;
  lease: BazaarLeaseGuard;
}): Promise<BazaarOutcomeResult> {
  const { order, paymentResponse, store, wiring, listing, leaseToken, lease } = input;
  if (order.state !== "dispatch_started") {
    try {
      lease.assertOwned();
      await input.assertListingCurrent();
      lease.assertOwned();
    } catch {
      if (lease.ownershipLost) return ownershipLost();
      const marked = await store.markTerminal(
        order.orderRecordId, leaseToken, "settled", "dispatch_failed",
        "provider_authority_changed_before_dispatch",
      );
      if (!marked) return existingOutcomeResult(await reload(store, order));
      lease.complete();
      return failureOutcome(409, "listing_authority_changed");
    }
  }
  if (order.state !== "dispatch_started") {
    lease.assertOwned();
    if (!(await store.beginDispatch(order.orderRecordId, leaseToken))) {
      return existingOutcomeResult(await reload(store, order));
    }
  }
  let dispatched;
  try {
    lease.assertOwned();
    dispatched = await wiring.fulfillment.dispatch({
      orderRecordId: order.orderRecordId,
      orderHandle: order.orderHandle,
      providerAgentId: order.providerAgentId,
      payer: order.payer,
      buyerAuthorizationDigest: order.authorizationDigest,
      outcomeId: order.outcomeId,
      listingCommitment: order.listingCommitment,
      requestHash: order.requestHash,
      settlementTransaction: paymentResponse.transaction as Hex,
    }, lease.signal);
    lease.assertOwned();
  } catch {
    if (lease.ownershipLost) return ownershipLost();
    const marked = await store.markTerminal(
      order.orderRecordId, leaseToken, "dispatch_started", "dispatch_failed",
      "provider_dispatch_failed",
    );
    if (!marked) return existingOutcomeResult(await reload(store, order));
    lease.complete();
    return failureOutcome(502, "provider_dispatch_failed");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(dispatched.taskId)) {
    const marked = await store.markTerminal(
      order.orderRecordId, leaseToken, "dispatch_started", "dispatch_failed",
      "provider_task_id_invalid",
    );
    if (!marked) return existingOutcomeResult(await reload(store, order));
    lease.complete();
    return failureOutcome(502, "provider_dispatch_failed");
  }
  const marked = await store.markDispatched(
    order.orderRecordId,
    leaseToken,
    dispatched.taskId,
    keccak256(toBytes(dispatched.taskId)),
  );
  if (!marked) return existingOutcomeResult(await reload(store, order));
  lease.complete();
  return successOutcome(order.orderHandle, listing.resourceUrl, paymentResponse);
}

function ownershipLost(): BazaarOutcomeResult {
  return failureOutcome(409, "processing_ownership_lost");
}

async function reload(store: BazaarOrderStore, order: BazaarOrder): Promise<BazaarOrder> {
  return (await store.getByRecordId(order.orderRecordId)) ?? order;
}
