import type { ChainProjectionDescriptor } from "../chain/eventTypes.js";
import type { ChainEventReader, ChainStatusReader } from "../chain/reader.js";
import {
  ChainProjectionDescriptorError,
  ChainProjectionIntegrityError,
} from "../db/chainEventQueries.js";
import type { Queries } from "../db/queries.js";
import { logger } from "../util/logger.js";

type ProjectionReader = ChainEventReader & ChainStatusReader;

interface IndexerFailure {
  category: "rpc" | "descriptor_mismatch" | "projection_integrity";
  message: string;
  at: Date;
}

export class ChainEventsIndexer {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopping = false;
  private initialized = false;
  private terminal = false;
  private cachedCursor: bigint | null = null;
  private confirmedHead: bigint | null = null;
  private lastSuccessAt: Date | null = null;
  private lastFailure: IndexerFailure | null = null;

  constructor(
    private readonly reader: ProjectionReader,
    private readonly queries: Queries,
    private readonly descriptor: ChainProjectionDescriptor,
    private readonly options: {
      pollIntervalMs?: number;
      blockRangePerCall?: bigint;
      confirmationDepthBlocks?: bigint;
    } = {},
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      this.cachedCursor = await this.queries.getOrAdoptChainProjection(
        this.descriptor,
      );
      await this.refreshSharedState();
      this.initialized = true;
    } catch (error) {
      if (error instanceof ChainProjectionDescriptorError) {
        await this.queries.recordChainProjectionTerminalFailure({
          category: "descriptor_mismatch",
          message: error.message,
        });
      }
      throw error;
    }
  }

  start(): void {
    if (this.timer || this.stopping || this.terminal) return;
    void this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.options.pollIntervalMs ?? 5_000,
    );
  }

  async stopAndDrain(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  async tick(): Promise<void> {
    if (this.stopping || this.terminal) return;
    if (this.inFlight) return this.inFlight;
    const operation = this.runTick();
    this.inFlight = operation;
    try {
      await operation;
    } finally {
      if (this.inFlight === operation) this.inFlight = null;
    }
  }

  status() {
    const lagBlocks = this.lagBlocks();
    return {
      initialized: this.initialized,
      startBlock: this.descriptor.startBlock,
      lastIndexedBlock: this.cachedCursor,
      lastObservedConfirmedHead: this.confirmedHead,
      lagBlocks,
      lastSuccessAt: this.lastSuccessAt,
      lastFailure: this.lastFailure,
      terminal: this.terminal,
    };
  }

  isReady(now = Date.now()): boolean {
    const maximumAge = (this.options.pollIntervalMs ?? 5_000) * 6;
    return (
      this.initialized &&
      !this.terminal &&
      this.lastSuccessAt !== null &&
      now - this.lastSuccessAt.getTime() <= maximumAge &&
      this.lagBlocks() === 0n
    );
  }

  isFresh(now = Date.now()): boolean {
    return this.isReady(now);
  }

  private lagBlocks(): bigint | null {
    if (this.confirmedHead === null) return null;
    if (this.confirmedHead < this.descriptor.startBlock) return 0n;
    if (this.cachedCursor === null) {
      return this.confirmedHead - this.descriptor.startBlock + 1n;
    }
    return this.confirmedHead > this.cachedCursor
      ? this.confirmedHead - this.cachedCursor
      : 0n;
  }

  private async runTick(): Promise<void> {
    try {
      if (!this.initialized) await this.initialize();
      await this.refreshSharedState();
      if (this.terminal) return;
      const confirmedHead = await this.observeConfirmedHead();
      const leadership = await this.queries.tryWithChainProjectionLock(
        async () => {
          await this.refreshSharedState();
          if (this.terminal) return;
          await this.pollToConfirmedHead(confirmedHead);
        },
      );
      if (!leadership.acquired) await this.refreshSharedState();
      if (this.terminal) return;
      this.lastSuccessAt = new Date();
      if (this.lastFailure) logger.info("chain events indexer recovered");
      this.lastFailure = null;
    } catch (error) {
      const category =
        error instanceof ChainProjectionDescriptorError
          ? "descriptor_mismatch"
          : error instanceof ChainProjectionIntegrityError
            ? "projection_integrity"
            : "rpc";
      this.terminal = category !== "rpc";
      const firstFailure = this.lastFailure === null;
      this.lastFailure = {
        category,
        message: error instanceof Error ? error.message : String(error),
        at: new Date(),
      };
      if (firstFailure) {
        logger.error("chain events indexer became unhealthy", {
          category,
          message: this.lastFailure.message,
        });
      }
      if (category !== "rpc") {
        await this.queries
          .recordChainProjectionTerminalFailure({
            category,
            message: this.lastFailure.message,
          })
          .catch(() => undefined);
      }
      if (this.terminal && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
  }

  private async refreshSharedState(): Promise<void> {
    const state = await this.queries.getChainProjectionState(this.descriptor);
    this.cachedCursor = state.cursor;
    if (!state.terminalFailure) return;
    this.terminal = true;
    this.lastFailure = state.terminalFailure;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async observeConfirmedHead(): Promise<bigint> {
    const head = await this.reader.getBlockNumber();
    const confirmationDepth = this.options.confirmationDepthBlocks ?? 12n;
    const confirmedHead =
      head > confirmationDepth ? head - confirmationDepth : 0n;
    this.confirmedHead = confirmedHead;
    return confirmedHead;
  }

  private async pollToConfirmedHead(confirmedHead: bigint): Promise<void> {
    if (confirmedHead < this.descriptor.startBlock) return;
    if (this.cachedCursor !== null && this.cachedCursor >= confirmedHead) {
      return;
    }

    const range = this.options.blockRangePerCall ?? 2_000n;
    let fromBlock =
      this.cachedCursor === null
        ? this.descriptor.startBlock
        : this.cachedCursor + 1n;
    while (fromBlock <= confirmedHead && !this.stopping) {
      const toBlock =
        fromBlock + range - 1n > confirmedHead
          ? confirmedHead
          : fromBlock + range - 1n;
      const events = await this.reader.getChainProjectionEvents(
        fromBlock,
        toBlock,
      );
      await this.queries.applyChainProjectionPage({
        descriptor: this.descriptor,
        fromBlock,
        toBlock,
        events,
      });
      this.cachedCursor = toBlock;
      fromBlock = toBlock + 1n;
    }
  }
}
