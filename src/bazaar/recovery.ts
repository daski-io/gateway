import { randomUUID } from "node:crypto";
import type { ProviderAuthorityService } from "../payment/providerAuthority.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { dispatchBazaarOrder } from "./outcomeDispatch.js";
import { paymentResponseFromOrder } from "./outcomeHelpers.js";
import { requireCurrentListing } from "./listingAuthority.js";
import { type BazaarLeaseGuard, withBazaarLease } from "./lease.js";
import { verifyBazaarSettlementEvidence } from "./settlementEvidence.js";
import { refundRiskPolicyFor } from "./refundPolicy.js";
import type { BazaarOrderStore, LeasedBazaarOrder } from "./store.js";
import type {
  BazaarCompatibilityWiring,
  BazaarListing,
  BazaarOrder,
} from "./types.js";

const RECONCILE_INTERVAL_MS = 30_000;

export class BazaarRecoveryRuntime {
  private readonly owner = `gateway-recovery:${randomUUID()}`;
  private readonly listings: Map<string, BazaarListing>;
  private interval: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly store: BazaarOrderStore,
    private readonly wiring: BazaarCompatibilityWiring,
    private readonly providerAuthority: ProviderAuthorityService,
  ) {
    this.listings = new Map(wiring.listings.map((listing) => [
      listing.listingCommitment.toLowerCase(), listing,
    ]));
  }

  async start(): Promise<void> {
    if (this.interval) return;
    this.interval = setInterval(() => void this.schedule(), RECONCILE_INTERVAL_MS);
    this.interval.unref();
    await this.schedule();
  }

  async runOnce(): Promise<void> {
    await this.store.terminalizeExpiredAttempts();
    for (let processed = 0; processed < 50; processed += 1) {
      const recoverable = await this.store.claimRecoverableOrders(this.owner, 1);
      const leased = recoverable[0];
      if (!leased) break;
      await this.recover(leased);
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
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
        policy: refundRiskPolicyFor(
          this.wiring.refundRiskPolicies,
          order.providerAgentId,
        ),
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
}
