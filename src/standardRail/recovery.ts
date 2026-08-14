import { randomUUID } from "node:crypto";
import { logger } from "../util/logger.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardRailStore } from "./store.js";
import type { StandardOrderRecord } from "./types.js";

interface RecoveryOptions {
  config: StandardRailConfig;
  store: StandardRailStore;
  refund(order: StandardOrderRecord): Promise<void>;
  resumePaid(order: StandardOrderRecord): Promise<void>;
  releaseExposure(order: StandardOrderRecord): Promise<"released" | "legal_hold">;
  cleanupUploads(): Promise<void>;
  recordRecoveryApprovalExpiry(order: StandardOrderRecord): Promise<void>;
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
    await this.options.cleanupUploads();
    const skipped: string[] = [];
    for (let count = 0; count < 50; count += 1) {
      const order = await this.options.store.leaseRecoverable(
        this.workerId,
        this.options.config.leaseSeconds,
        skipped,
      );
      if (!order) return;
      try {
        const recoveryCutoff = Math.min(
          this.options.config.manifest.activeRailProfile.payload.recoveryValidBefore,
          this.options.config.manifest.runtimeRelease.payload.recoveryValidBefore,
        ) * 1_000;
        if (Date.now() >= recoveryCutoff) {
          await this.options.recordRecoveryApprovalExpiry(order);
          logger.error("standard-rail recovery approval expired", {
            orderId: order.orderId,
            state: order.state,
          });
          await this.options.store.releaseLease(order.orderId, this.workerId, order.leaseFence);
          skipped.push(order.orderId);
          continue;
        }
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
        case "PROVIDER_FAILED": return 30;
        case "FULFILLED": return listing.refundPolicy.requestDeadlineSeconds;
        case "REFUND_DUE":
        case "REFUND_RESERVED":
        case "REFUND_INVOKED":
        case "REFUND_AMBIGUOUS": return 30;
        default: return policy.refundSeconds;
      }
    })();
    const policyCutoff = this.options.config.manifest.activeRailProfile.payload.recoveryValidBefore * 1_000;
    const dueAt = order.updatedAt.getTime() + seconds * 1_000;
    return Date.now() >= Math.min(dueAt, policyCutoff);
  }

  private async recover(order: StandardOrderRecord): Promise<void> {
    switch (order.state) {
      case "CHALLENGE_ISSUED":
        await this.options.store.transition(order, "NO_REFUND", "signed_deadline_no_captured_payment");
        await this.options.store.releaseCapacity(order.orderId);
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
      case "PROVIDER_FAILED":
        await this.options.store.releaseCapacity(order.orderId);
        await this.options.store.transition(order, "REFUND_DUE", "provider_failure_refund_due");
        return;
      case "FULFILLED":
        if (await this.options.releaseExposure(order) === "released") {
          await this.options.store.transition(order, "NO_REFUND", "buyer_refund_window_elapsed");
        } else {
          await this.options.store.transition(
            order,
            "LEGAL_HOLD",
            "provider_exposure_release_deadline_elapsed",
          );
          await this.options.store.releaseCapacity(order.orderId);
        }
        return;
      case "REFUND_DUE":
      case "REFUND_RESERVED":
      case "REFUND_INVOKED":
      case "REFUND_AMBIGUOUS":
        await this.options.refund(order);
        return;
      default:
        await this.options.store.releaseLease(order.orderId, this.workerId, order.leaseFence);
    }
  }
}
