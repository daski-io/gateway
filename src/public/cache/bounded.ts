export interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

export class BoundedCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("cache maxEntries must be a positive integer");
    }
  }

  get(key: K): CacheEntry<V> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: K, value: V, fetchedAt = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, fetchedAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
