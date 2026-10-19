import v8 from "node:v8";
import { logger, type GatewayLogger } from "../util/logger.js";

/** How often a serving gateway logs its memory unless MEMORY_REPORT_INTERVAL_MS overrides it. */
export const MEMORY_REPORT_INTERVAL_MS = 300_000;

const MEBIBYTE = 1024 * 1024;

/** Process memory in MiB, to one decimal place. */
export interface MemoryReport {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  /** The V8 heap limit the process stops at. */
  heapSizeLimitMb: number;
}

function mebibytes(bytes: number): number {
  return Math.round((bytes / MEBIBYTE) * 10) / 10;
}

export function readMemoryReport(): MemoryReport {
  const usage = process.memoryUsage();
  return {
    rssMb: mebibytes(usage.rss),
    heapUsedMb: mebibytes(usage.heapUsed),
    heapTotalMb: mebibytes(usage.heapTotal),
    externalMb: mebibytes(usage.external),
    arrayBuffersMb: mebibytes(usage.arrayBuffers),
    heapSizeLimitMb: mebibytes(v8.getHeapStatistics().heap_size_limit),
  };
}

/**
 * Logs one `process memory` line every `intervalMs` (`0` logs none), so heap
 * growth shows in the service log long before the process reaches its V8
 * limit. The timer never keeps the process alive, and a failed reading is
 * logged without stopping it. The returned function stops the reports.
 */
export function startMemoryReports(options: {
  intervalMs?: number;
  log?: Pick<GatewayLogger, "info" | "warn">;
  read?: () => MemoryReport;
} = {}): () => void {
  const intervalMs = options.intervalMs ?? MEMORY_REPORT_INTERVAL_MS;
  if (intervalMs === 0) return () => undefined;
  const log = options.log ?? logger;
  const read = options.read ?? readMemoryReport;
  const timer = setInterval(() => {
    let report: MemoryReport;
    try {
      report = read();
    } catch (error) {
      log.warn("process memory could not be read", { error });
      return;
    }
    log.info("process memory", report);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
