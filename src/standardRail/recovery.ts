import { randomUUID } from "node:crypto";
import { logger } from "../util/logger.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardRailStore } from "./store.js";
import type { StandardOrderRecord } from "./types.js";

interface RecoveryOptions {
  config: StandardRailConfig;
  store: StandardRailStore;
  resumePaid(order: StandardOrderRecord): Promise<void>;
  cleanup(): Promise<void>;
}

export class StandardRailRecoveryWorker {
  private readonly workerId = `standard-recovery-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: RecoveryOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.schedule(), this.options.config.recoveryIntervalMs);
    this.timer.unref();
    this.schedule();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private schedule(): void {
    if (this.running) return;
    this.running = this.runBatch()
      .catch((error) => logger.error("standard-rail recovery batch failed", { error }))
      .finally(() => { this.running = null; });
  }

  private async runBatch(): Promise<void> {
    await this.options.cleanup();
    const skipped: string[] = [];
    for (let count = 0; count < 50; count += 1) {
      const order = await this.options.store.leaseRecoverable(
        this.workerId,
        this.options.config.leaseSeconds,
        skipped,
      );
      if (!order) return;
      try {
        if (!this.isDue(order)) {
          await this.options.store.releaseLease(order.orderId, this.workerId, order.leaseFence);
          skipped.push(order.orderId);
          continue;
        }
        await this.recover(order);
      } catch (error) {
        logger.error("standard-rail order recovery failed", {
          orderId: order.orderId,
          state: order.state,
          error,
        });
        await this.options.store.releaseLease(order.orderId, this.workerId, order.leaseFence);
        skipped.push(order.orderId);
      }
    }
  }

  private isDue(order: StandardOrderRecord): boolean {
    const listing = order.listing;
    const policy = listing.deadlinePolicy;
    const seconds = (() => {
      switch (order.state) {
        case "CHALLENGE_ISSUED": return Math.max(30, Math.floor((order.expiresAt.getTime() - order.updatedAt.getTime()) / 1_000));
        case "ATTEMPT_OPENED":
        case "VERIFIED":
        case "VERIFY_REJECTED":
        case "SETTLE_INVOKED":
        case "FACILITATOR_CONFIRMED":
        case "SETTLEMENT_AMBIGUOUS":
        case "SETTLEMENT_FAILED":
        case "EXTERNAL_OR_UNPROVEN_DEPOSIT":
        case "DEPOSIT_FINAL":
        case "RELEASE_FINAL":
        case "DISPATCH_STARTED":
        case "DISPATCH_AMBIGUOUS": return 30;
        case "DISPATCHED":
        case "INPUT_REQUIRED": return 30;
        default: return policy.fulfillmentSeconds;
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
        await this.options.resumePaid(order);
        return;
      default:
        await this.options.store.releaseLease(order.orderId, this.workerId, order.leaseFence);
    }
  }
}
