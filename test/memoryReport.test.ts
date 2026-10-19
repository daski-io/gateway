import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_REPORT_INTERVAL_MS,
  readMemoryReport,
  startMemoryReports,
  type MemoryReport,
} from "../src/runtime/memoryReport.js";

const SAMPLE: MemoryReport = {
  rssMb: 512.3, heapUsedMb: 301.2, heapTotalMb: 340, externalMb: 12.5, arrayBuffersMb: 1.1, heapSizeLimitMb: 4144,
};

function recorder() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("process memory reports", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads the process memory and the V8 heap limit in MiB to one decimal", () => {
    const report = readMemoryReport();
    expect(Object.keys(report).sort()).toEqual([
      "arrayBuffersMb", "externalMb", "heapSizeLimitMb", "heapTotalMb", "heapUsedMb", "rssMb",
    ]);
    for (const value of Object.values(report)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(Number((value * 10).toFixed(6)) % 1).toBe(0);
    }
    expect(report.rssMb).toBeGreaterThan(0);
    expect(report.heapUsedMb).toBeGreaterThan(0);
    expect(report.heapSizeLimitMb).toBeGreaterThan(report.heapTotalMb);
  });

  it("logs one line every five minutes by default until stopped", () => {
    vi.useFakeTimers();
    const log = recorder();
    const stop = startMemoryReports({ log, read: () => SAMPLE });
    vi.advanceTimersByTime(MEMORY_REPORT_INTERVAL_MS - 1);
    expect(log.info).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(log.info).toHaveBeenCalledExactlyOnceWith("process memory", SAMPLE);
    vi.advanceTimersByTime(MEMORY_REPORT_INTERVAL_MS * 2);
    expect(log.info).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(MEMORY_REPORT_INTERVAL_MS * 3);
    expect(log.info).toHaveBeenCalledTimes(3);
    expect(log.warn).not.toHaveBeenCalled();
    expect(MEMORY_REPORT_INTERVAL_MS).toBe(300_000);
  });

  it("never keeps the process alive", () => {
    const realSetInterval = globalThis.setInterval;
    const timers: NodeJS.Timeout[] = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, ms: number) => {
      const timer = realSetInterval(handler, ms);
      timers.push(timer);
      return timer;
    }) as unknown as typeof setInterval);
    const stop = startMemoryReports({ intervalMs: 60_000, log: recorder(), read: () => SAMPLE });
    try {
      expect(timers).toHaveLength(1);
      expect(timers[0]!.hasRef()).toBe(false);
    } finally {
      stop();
    }
  });

  it("logs a failed reading and keeps reporting", () => {
    vi.useFakeTimers();
    const log = recorder();
    const read = vi.fn<() => MemoryReport>()
      .mockImplementationOnce(() => { throw new Error("EMFILE: too many open files"); })
      .mockReturnValue(SAMPLE);
    const stop = startMemoryReports({ intervalMs: 10_000, log, read });
    vi.advanceTimersByTime(10_000);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      "process memory could not be read", { error: expect.any(Error) },
    );
    expect(log.info).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(log.info).toHaveBeenCalledExactlyOnceWith("process memory", SAMPLE);
    stop();
  });

  it("reports nothing when the interval is 0", () => {
    vi.useFakeTimers();
    const log = recorder();
    const stop = startMemoryReports({ intervalMs: 0, log, read: () => SAMPLE });
    vi.advanceTimersByTime(MEMORY_REPORT_INTERVAL_MS * 10);
    stop();
    expect(log.info).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
