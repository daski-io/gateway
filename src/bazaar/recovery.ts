import { randomUUID } from "node:crypto";
import type { ProviderAuthorityService } from "../payment/providerAuthority.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { dispatchBazaarOrder } from "./outcomeDispatch.js";
import { paymentResponseFromOrder } from "./outcomeHelpers.js";
import { requireCurrentListing } from "./listingAuthority.js";
import { type BazaarLeaseGuard, withBazaarLease } from "./lease.js";
import { verifyBazaarSettlementEvidence } from "./settlementEvidence.js";
import { BazaarObservationStore } from "./observationStore.js";
import type { LeasedBazaarObservation } from "./observationLeaseStore.js";
import { observeBazaarSettlement } from "./settlementObservation.js";
import { BazaarRefundRecovery } from "./refundRecovery.js";
import type { BazaarRefundStore } from "./refundStore.js";
import { BazaarFulfillmentRecovery } from "./fulfillmentRecovery.js";
import type { BazaarFulfillmentStore } from "./fulfillmentStore.js";
import type { BazaarOrderStore, LeasedBazaarOrder } from "./store.js";
import type {
  BazaarCompatibilityWiring,
  BazaarListing,
  BazaarObservationOriginState,
  BazaarOrder,
} from "./types.js";

const RECONCILE_INTERVAL_MS = 30_000;
export class BazaarRecoveryRuntime {
  private readonly owner = `gateway-recovery:${randomUUID()}`;
  private readonly shutdown = new AbortController();
  private readonly listings: Map<string, BazaarListing>;
  private interval: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;
  private readonly refundRecovery: BazaarRefundRecovery;
  private readonly fulfillmentRecovery: BazaarFulfillmentRecovery;

  constructor(
    private readonly store: BazaarOrderStore,
    private readonly observationStore: BazaarObservationStore,
    refundStore: BazaarRefundStore,
    fulfillmentStore: BazaarFulfillmentStore,
    private readonly wiring: BazaarCompatibilityWiring,
    private readonly providerAuthority: ProviderAuthorityService,
  ) {
    this.refundRecovery = new BazaarRefundRecovery(
      refundStore,
      wiring,
      this.owner,
      this.shutdown.signal,
    );
    this.fulfillmentRecovery = new BazaarFulfillmentRecovery(
      fulfillmentStore,
      wiring,
      this.owner,
      this.shutdown.signal,
    );
    this.listings = new Map(wiring.listings.map((listing) => [
      listing.listingCommitment.toLowerCase(), listing,
    ]));
  }

  async start(): Promise<void> {
    if (this.interval || this.stopping) return;
    this.interval = setInterval(() => void this.schedule(), RECONCILE_INTERVAL_MS);
    this.interval.unref();
    await this.schedule();
  }

  async runOnce(): Promise<void> {
    if (this.stopping) return;
    await this.store.terminalizeExpiredAttempts();
    for (let processed = 0; processed < 50; processed += 1) {
      if (this.stopping) return;
      const observable = await this.observationStore.claim(
        this.owner,
        this.nowSeconds(),
        this.wiring.settlementObservationPolicy,
      );
      if (!observable) break;
      await this.observe(observable);
    }
    if (this.stopping) return;
    await this.refundRecovery.runOnce();
    for (let processed = 0; processed < 50; processed += 1) {
      if (this.stopping) return;
      const recoverable = await this.store.claimRecoverableOrders(this.owner, 1);
      const leased = recoverable[0];
      if (!leased) break;
      await this.recover(leased);
    }
    if (this.stopping) return;
    await this.fulfillmentRecovery.runOnce();
  }

  private async observe(leased: LeasedBazaarObservation): Promise<void> {
    await withBazaarLease({
      store: this.observationStore,
      orderRecordId: leased.order.orderRecordId,
      leaseToken: leased.leaseToken,
      action: (lease) => this.observeLeased(leased, lease),
      onOwnershipLost: () => undefined,
      signal: this.shutdown.signal,
    });
  }

  private async observeLeased(
    leased: LeasedBazaarObservation,
    lease: BazaarLeaseGuard,
  ): Promise<void> {
    const result = await observeBazaarSettlement({
      order: leased.order,
      wiring: this.wiring,
      lease,
    });
    if (result.kind === "pending") {
      const deferred = await this.observationStore.defer(
        leased.order.orderRecordId,
        leased.leaseToken,
        this.wiring.settlementObservationPolicy.retryDelaySeconds,
      );
      if (deferred) lease.complete();
      return;
    }
    if (result.kind === "no_transfer") {
      const completed = await this.observationStore.completeNoTransfer({
        orderRecordId: leased.order.orderRecordId,
        originState: leased.originState,
        terminalState: noTransferState(leased.originState),
        leaseToken: leased.leaseToken,
        observation: result,
      });
      if (completed) lease.complete();
      return;
    }
    const requiresRefund = leased.originState === "settle_ambiguous" ||
      leased.originState === "evidence_rejected";
    const completed = requiresRefund
      ? await this.observationStore.completeObservedTransfer({
          orderRecordId: leased.order.orderRecordId,
          originState: leased.originState,
          leaseToken: leased.leaseToken,
          observation: result,
          disposition: "refund_due",
          reason: leased.originState === "evidence_rejected"
            ? "SETTLEMENT_EVIDENCE_INVALID"
            : "AMBIGUOUS_PAID",
        })
      : await this.observationStore.completeObservedTransfer({
          orderRecordId: leased.order.orderRecordId,
          originState: leased.originState,
          leaseToken: leased.leaseToken,
          observation: result,
          disposition: "unapproved",
        });
    if (completed) lease.complete();
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.shutdown.abort(new Error("Bazaar recovery is shutting down"));
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await this.active;
  }

  private async schedule(): Promise<void> {
    if (this.stopping || this.active) return;
    const operation = this.runOnce().catch((error) => {
      logErrorWithId("bazaar.reconcile", error);
    });
    this.active = operation;
    try {
      await operation;
    } finally {
      if (this.active === operation) this.active = null;
    }
  }

  private async recover(leased: LeasedBazaarOrder): Promise<void> {
    await withBazaarLease({
      store: this.store,
      orderRecordId: leased.order.orderRecordId,
      leaseToken: leased.leaseToken,
      action: (lease) => this.recoverLeased(leased, lease),
      onOwnershipLost: () => undefined,
      signal: this.shutdown.signal,
    });
  }

  private async recoverLeased(
    leased: LeasedBazaarOrder,
    lease: BazaarLeaseGuard,
  ): Promise<void> {
    let order = leased.order;
    const listing = this.listings.get(order.listingCommitment.toLowerCase());
    if (!listing) {
      if (await this.failMissingListing(order, leased.leaseToken)) lease.complete();
      return;
    }
    if (order.state === "settle_confirmed") {
      const evidence = await verifyBazaarSettlementEvidence(order, this.wiring, lease);
      if (evidence.kind !== "valid") {
        const marked = await this.store.markTerminal(
          order.orderRecordId,
          leased.leaseToken,
          "settle_confirmed",
          evidence.kind === "invalid" ? "evidence_rejected" : "settle_ambiguous",
          evidence.kind === "invalid"
            ? "invalid_settlement_evidence"
            : "evidence_observation_ambiguous",
        );
        if (marked) lease.complete();
        return;
      }
      lease.assertOwned();
      if (!(await this.store.markSettled(order.orderRecordId, leased.leaseToken))) return;
      order = (await this.store.getByRecordId(order.orderRecordId)) ?? order;
    }
    if (order.state !== "settled" && order.state !== "dispatch_started") return;
    await dispatchBazaarOrder({
      order,
      paymentResponse: paymentResponseFromOrder(order),
      store: this.store,
      wiring: this.wiring,
      listing,
      leaseToken: leased.leaseToken,
      assertListingCurrent: () => requireCurrentListing(
        listing,
        this.providerAuthority,
        BigInt(Math.floor((this.wiring.now?.() ?? new Date()).getTime() / 1000)),
        true,
      ),
      lease,
    });
  }

  private async failMissingListing(order: BazaarOrder, leaseToken: string): Promise<boolean> {
    if (order.state === "settled" || order.state === "dispatch_started") {
      return this.store.markDispatchRefundDue({
        orderRecordId: order.orderRecordId,
        leaseToken,
        expected: order.state,
        reason: "PROVIDER_COMPLIANCE_FAILURE",
        failureCode: "listing_manifest_missing_during_recovery",
      });
    }
    return this.store.markTerminal(
      order.orderRecordId,
      leaseToken,
      order.state,
      "evidence_rejected",
      "listing_manifest_missing_during_recovery",
    );
  }

  private nowSeconds(): bigint {
    return BigInt(Math.floor((this.wiring.now?.() ?? new Date()).getTime() / 1000));
  }
}

function noTransferState(origin: BazaarObservationOriginState):
  | "rejected_expired_no_transfer"
  | "ambiguous_expired_no_transfer"
  | "invalid_evidence_expired_no_transfer" {
  if (origin === "evidence_rejected") return "invalid_evidence_expired_no_transfer";
  return origin === "verify_ambiguous" || origin === "settle_ambiguous"
    ? "ambiguous_expired_no_transfer"
    : "rejected_expired_no_transfer";
}
