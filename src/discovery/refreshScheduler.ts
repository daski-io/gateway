import type { GatewayLogger } from "../util/logger.js";

const FAST_RETRY_BASE_MS = 15_000;

interface RefreshSchedulerOptions {
  refreshIntervalMs: number;
  refresh: () => Promise<void>;
  awaitingFirstCard: () => boolean;
  logger: Pick<GatewayLogger, "error">;
}

export class DiscoveryRefreshScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private fastRetryDelayMs = FAST_RETRY_BASE_MS;

  constructor(private readonly options: RefreshSchedulerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    let delayMs = this.options.refreshIntervalMs;
    if (this.options.awaitingFirstCard()) {
      delayMs = Math.min(this.fastRetryDelayMs, this.options.refreshIntervalMs);
      this.fastRetryDelayMs = Math.min(
        this.fastRetryDelayMs * 2,
        this.options.refreshIntervalMs,
      );
    } else {
      this.fastRetryDelayMs = FAST_RETRY_BASE_MS;
    }
    this.timer = setTimeout(() => {
      void this.options
        .refresh()
        .catch((error) => {
          this.options.logger.error(
            `[cache] refresh threw: ${(error as Error).message}`,
          );
        })
        .finally(() => this.scheduleNext());
    }, delayMs);
  }
}
