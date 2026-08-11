import type { SettleResponse } from "@x402/core/types";
import { keccak256, toBytes, type Hex } from "viem";
import { isHex32 } from "../util/evmValidation.js";
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
  BazaarDispatchResult,
  BazaarListing,
  BazaarOrder,
} from "./types.js";
import { callBazaarAdapter } from "./adapterCall.js";

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
      const marked = await store.markDispatchRefundDue({
        orderRecordId: order.orderRecordId,
        leaseToken,
        expected: "settled",
        reason: "PROVIDER_COMPLIANCE_FAILURE",
        failureCode: "provider_authority_changed_before_dispatch",
      });
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
  let response: unknown;
  try {
    lease.assertOwned();
    response = await callBazaarAdapter({
      timeoutMs: wiring.adapterCallTimeoutMs,
      signal: lease.signal,
      operation: (signal) => wiring.fulfillment.dispatch({
        orderRecordId: order.orderRecordId,
        orderHandle: order.orderHandle,
        providerAgentId: order.providerAgentId,
        payer: order.payer,
        buyerAuthorizationDigest: order.authorizationDigest,
        outcomeId: order.outcomeId,
        listingCommitment: order.listingCommitment,
        requestHash: order.requestHash,
        settlementTransaction: paymentResponse.transaction as Hex,
      }, signal),
    });
    lease.assertOwned();
  } catch {
    if (lease.ownershipLost) return ownershipLost();
    const marked = await store.markDispatchAmbiguous(
      order.orderRecordId,
      leaseToken,
      "provider_dispatch_ambiguous",
    );
    if (!marked) return existingOutcomeResult(await reload(store, order));
    lease.complete();
    return existingOutcomeResult(await reload(store, order));
  }
  const dispatched = parseDispatchResult(response);
  if (
    !dispatched ||
    dispatched.orderRecordId.toLowerCase() !== order.orderRecordId.toLowerCase()
  ) {
    const marked = await store.markDispatchAmbiguous(
      order.orderRecordId,
      leaseToken,
      "provider_dispatch_response_invalid",
    );
    if (!marked) return existingOutcomeResult(await reload(store, order));
    lease.complete();
    return existingOutcomeResult(await reload(store, order));
  }
  if (dispatched.kind === "rejected") {
    const marked = await store.markDispatchRefundDue({
      orderRecordId: order.orderRecordId,
      leaseToken,
      expected: "dispatch_started",
      reason: dispatched.reason,
      failureCode: "provider_dispatch_rejected",
    });
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
  if (marked === "task_conflict") {
    const conflicted = await store.markDispatchAmbiguous(
      order.orderRecordId,
      leaseToken,
      "provider_task_identity_conflict",
    );
    if (conflicted) lease.complete();
    return existingOutcomeResult(await reload(store, order));
  }
  if (marked === "ownership_lost") {
    return existingOutcomeResult(await reload(store, order));
  }
  lease.complete();
  return successOutcome(order.orderHandle, listing.resourceUrl, paymentResponse);
}

function parseDispatchResult(value: unknown): BazaarDispatchResult | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === "accepted" &&
    hasExactKeys(value, ["kind", "orderRecordId", "taskId"]) &&
    isHex32(value.orderRecordId) &&
    typeof value.taskId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value.taskId)
  ) return {
    kind: "accepted",
    orderRecordId: value.orderRecordId,
    taskId: value.taskId,
  };
  if (
    value.kind === "rejected" &&
    hasExactKeys(value, ["kind", "orderRecordId", "reason"]) &&
    isHex32(value.orderRecordId) &&
    (value.reason === "PROVIDER_COMPLIANCE_FAILURE" ||
      value.reason === "PROVIDER_FULFILLMENT_FAILURE")
  ) return {
    kind: "rejected",
    orderRecordId: value.orderRecordId,
    reason: value.reason,
  };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function ownershipLost(): BazaarOutcomeResult {
  return failureOutcome(409, "processing_ownership_lost");
}

async function reload(store: BazaarOrderStore, order: BazaarOrder): Promise<BazaarOrder> {
  return (await store.getByRecordId(order.orderRecordId)) ?? order;
}
