import { randomUUID } from "node:crypto";
import type { ProviderAuthorityService } from "../payment/providerAuthority.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { dispatchBazaarOrder } from "./outcomeDispatch.js";
import { paymentResponseFromOrder } from "./outcomeHelpers.js";
import { requireCurrentListing } from "./listingAuthority.js";
import { withBazaarLease } from "./lease.js";
import { verifyBazaarSettlementEvidence } from "./settlementEvidence.js";
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
    const recoverable = await this.store.claimRecoverableOrders(this.owner);
    for (const leased of recoverable) await this.recover(leased);
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
      action: () => this.recoverLeased(leased),
    });
  }

  private async recoverLeased(leased: LeasedBazaarOrder): Promise<void> {
    let order = leased.order;
    const listing = this.listings.get(order.listingCommitment.toLowerCase());
    if (!listing) {
      await this.failMissingListing(order, leased.leaseToken);
      return;
    }
    if (order.state === "settle_confirmed") {
      const evidence = await verifyBazaarSettlementEvidence(order, this.wiring);
      if (evidence.kind !== "valid") {
        await this.store.markTerminal(
          order.orderRecordId,
          leased.leaseToken,
          "settle_confirmed",
          evidence.kind === "invalid" ? "evidence_rejected" : "settle_ambiguous",
          evidence.kind === "invalid"
            ? "invalid_settlement_evidence"
            : "evidence_observation_ambiguous",
        );
        return;
      }
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
    });
  }

  private async failMissingListing(order: BazaarOrder, leaseToken: string): Promise<void> {
    const dispatchState = order.state === "settled" || order.state === "dispatch_started";
    await this.store.markTerminal(
      order.orderRecordId,
      leaseToken,
      order.state,
      dispatchState ? "dispatch_failed" : "evidence_rejected",
      "listing_manifest_missing_during_recovery",
    );
  }
}
