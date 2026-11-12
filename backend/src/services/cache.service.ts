import { CONFIG } from '../config';
import { cacheEntries, cacheHits, cacheMisses } from './metrics.service';

interface CacheEntry<T> {
  value: T;
  expiry: number;
}

/**
 * LRU + TTL cache with single-flight request deduplication.
 *
 * The cache is per-process by default. For multi-instance deployments,
 * set `CACHE_DRIVER=redis` to share the cache across workers — every
 * worker reads from / writes to the same Redis hash, so cache hits from
 * one worker benefit the others.
 *
 * Single-flight (in-flight promise coalescing) is always local; if two
 * requests hit two different workers simultaneously for the same uncached
 * key, both will fetch from upstream. This is an acceptable tradeoff —
 * the duplicate work is bounded by the small race window and the cache
 * will be warm after the first fetch.
 */

export class LruTtlCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private inFlightMap = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number = CONFIG.CACHE_TTL_MS,
    private readonly maxEntries: number = CONFIG.CACHE_MAX_ENTRIES
  ) {}

  public get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      cacheMisses.inc();
      return null;
    }
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      cacheMisses.inc();
      return null;
    }
    // Refresh LRU order (delete & re-insert)
    this.cache.delete(key);
    this.cache.set(key, entry);
    cacheHits.inc();
    return entry.value;
  }

  public set(key: string, value: T): void {
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiry: Date.now() + this.ttlMs });
    cacheEntries.set(this.cache.size);
  }

  /**
   * Single-flight request deduplication:
   * If a request for `key` is already in flight, await the pending promise
   * instead of launching duplicate work.
   */
  public async getOrExecute(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== null) return cached;

    const pending = this.inFlightMap.get(key);
    if (pending) return pending;

    const taskPromise = (async () => {
      try {
        const result = await fetcher();
        this.set(key, result);
        return result;
      } finally {
        this.inFlightMap.delete(key);
      }
    })();

    this.inFlightMap.set(key, taskPromise);
    return taskPromise;
  }

  public clearExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiry) this.cache.delete(key);
    }
    cacheEntries.set(this.cache.size);
  }

  public get size(): number {
    return this.cache.size;
  }
}
