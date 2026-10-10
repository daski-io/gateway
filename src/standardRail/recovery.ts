import { randomUUID } from "node:crypto";
import { logger } from "../util/logger.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardRailStore } from "./store.js";
import type { StandardListing, StandardOrderRecord } from "./types.js";

interface RecoveryOptions {
  config: StandardRailConfig;
  store: StandardRailStore;
  listing(providerAgentId: string, outcomeId: string): Promise<StandardListing>;
  resumePaid(order: StandardOrderRecord): Promise<void>;
  cleanup(): Promise<void>;
}

// How often the settlement lane looks for claimed or verified authorizations.
const SETTLEMENT_LANE_INTERVAL_MS = 2_000;

export class StandardRailRecoveryWorker {
  private readonly workerId = `standard-recovery-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private settlementTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private settling: Promise<void> | null = null;

  constructor(private readonly options: RecoveryOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.schedule(), this.options.config.recoveryIntervalMs);
    this.timer.unref();
    // A claimed or verified authorization expires unless it settles, so its
    // recovery runs on its own lane and never waits behind a batch busy with
    // slower work, such as polling a provider (2026-10-10: a verified order
    // expired unsettled while its listing was free).
    this.settlementTimer = setInterval(
      () => this.scheduleSettlement(),
      Math.min(SETTLEMENT_LANE_INTERVAL_MS, this.options.config.recoveryIntervalMs),
    );
    this.settlementTimer.unref();
    this.schedule();
    this.scheduleSettlement();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.settlementTimer) clearInterval(this.settlementTimer);
    this.timer = null;
    this.settlementTimer = null;
    await Promise.all([this.running, this.settling]);
  }

  private schedule(): void {
    if (this.running) return;
    this.running = this.runBatch("all")
      .catch((error) => logger.error("standard-rail recovery batch failed", { error }))
      .finally(() => { this.running = null; });
  }

  private scheduleSettlement(): void {
    if (this.settling) return;
    this.settling = this.runBatch("settlement")
      .catch((error) => logger.error("standard-rail settlement recovery batch failed", { error }))
      .finally(() => { this.settling = null; });
  }

  private async runBatch(lane: "all" | "settlement" = "all"): Promise<void> {
    if (lane === "all") await this.options.cleanup();
    const workerId = lane === "all" ? this.workerId : `${this.workerId}-settlement`;
    const skipped: string[] = [];
    for (let count = 0; count < 50; count += 1) {
      const order = await this.options.store.leaseRecoverable(
        workerId,
        this.options.config.leaseSeconds,
        skipped,
        lane,
      );
      if (!order) return;
      skipped.push(order.orderId);
      try {
        if (await this.isDue(order)) await this.recover(order);
      } catch (error) {
        logger.error("standard-rail order recovery failed", {
          orderId: order.orderId,
          state: order.state,
          error,
        });
      }
      // Transitions keep a live lease with its driver, so the worker hands
      // the order back explicitly once it is done with it; the next due
      // check then runs on the usual cadence.
      await this.options.store.releaseLease(order.orderId, workerId, order.leaseFence);
    }
  }

  private async isDue(order: StandardOrderRecord): Promise<boolean> {
    const seconds = await (async () => {
      switch (order.state) {
        case "CHALLENGE_ISSUED": return Math.max(30, Math.floor((order.expiresAt.getTime() - order.updatedAt.getTime()) / 1_000));
        case "ATTEMPT_OPENED":
        case "VERIFIED": return 5;
        case "VERIFY_REJECTED":
        case "SETTLE_INVOKED":
        case "FACILITATOR_CONFIRMED":
        case "SETTLEMENT_AMBIGUOUS":
        case "SETTLEMENT_FAILED":
        case "EXTERNAL_OR_UNPROVEN_DEPOSIT":
        case "DEPOSIT_FINAL":
          return 30;
        case "RELEASE_FINAL":
        case "DISPATCH_STARTED":
        case "DISPATCH_AMBIGUOUS": return 10;
        case "DISPATCHED":
        case "PROVIDER_FAILED":
        case "INPUT_REQUIRED": return 30;
        default: return (await this.options.listing(order.providerAgentId, order.outcomeId))
          .deadlinePolicy.fulfillmentSeconds;
      }
    })();
    const dueAt = order.updatedAt.getTime() + seconds * 1_000;
    return Date.now() >= dueAt;
  }

  private async recover(order: StandardOrderRecord): Promise<void> {
    switch (order.state) {
      case "CHALLENGE_ISSUED":
        await this.options.store.transition(order, "NOT_SETTLED", "signed_deadline_no_captured_payment");
        return;
      case "SETTLEMENT_FAILED":
      case "ATTEMPT_OPENED":
      case "VERIFIED":
      case "VERIFY_REJECTED":
      case "SETTLE_INVOKED":
      case "FACILITATOR_CONFIRMED":
      case "SETTLEMENT_AMBIGUOUS":
      case "EXTERNAL_OR_UNPROVEN_DEPOSIT":
      case "DEPOSIT_FINAL":
      case "RELEASE_FINAL":
      case "DISPATCH_STARTED":
      case "DISPATCH_AMBIGUOUS":
      case "DISPATCHED":
      case "INPUT_REQUIRED":
      case "PROVIDER_FAILED":
        await this.options.resumePaid(order);
        return;
      default:
        return;
    }
  }
}
