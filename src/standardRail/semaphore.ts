export class BoundedSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Semaphore limit is invalid");
  }

  async run<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
    await this.acquire(timeoutMs);
    try { return await work(); }
    finally { this.release(); }
  }

  private acquire(timeoutMs: number): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const grant = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active += 1;
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("SEMAPHORE_TIMEOUT"));
      }, timeoutMs);
      timer.unref();
      this.waiters.push(grant);
    });
  }

  private release(): void {
    this.active -= 1;
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next) { next(); return; }
    }
  }
}
