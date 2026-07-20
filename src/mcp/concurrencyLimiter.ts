export class ConcurrencyLimiter {
  private active = 0;
  private readonly activeByKey = new Map<string, number>();

  constructor(
    private readonly maximum: number,
    private readonly maximumPerKey: number,
  ) {
    if (
      !Number.isSafeInteger(maximum) ||
      maximum <= 0 ||
      !Number.isSafeInteger(maximumPerKey) ||
      maximumPerKey <= 0 ||
      maximumPerKey > maximum
    ) {
      throw new Error("concurrency limits must be positive integers");
    }
  }

  tryAcquire(key: string): (() => void) | null {
    const activeForKey = this.activeByKey.get(key) ?? 0;
    if (this.active >= this.maximum || activeForKey >= this.maximumPerKey) {
      return null;
    }
    this.active += 1;
    this.activeByKey.set(key, activeForKey + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const remaining = (this.activeByKey.get(key) ?? 1) - 1;
      if (remaining > 0) this.activeByKey.set(key, remaining);
      else this.activeByKey.delete(key);
    };
  }
}
