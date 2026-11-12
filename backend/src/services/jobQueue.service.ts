import { CONFIG } from '../config';
import type { IQueueAdapter, DownloadRequest, JobProgress, JobListener } from './queue.types';
import { InMemoryQueueAdapter } from './queueMemory';
import { storageService } from './storage.service';

/**
 * Queue adapter façade.
 *
 * The runtime selects `RedisQueueAdapter` when `QUEUE_DRIVER=redis` (or when
 * `REDIS_URL` is set), and `InMemoryQueueAdapter` otherwise. All routes
 * talk to `jobQueueService` and never need to know which adapter is active.
 *
 * This is the public API surface for the queue layer. Every method is a
 * thin forwarder; the heavy lifting lives in the adapter implementations.
 */

let adapter: IQueueAdapter | null = null;
let adapterStarting: Promise<void> | null = null;

function pickAdapter(): IQueueAdapter {
  if (CONFIG.QUEUE_DRIVER === 'redis') {
    // Lazy require so the ioredis / bullmq imports only happen when actually needed.
    // This keeps the in-memory deployment dependency-free.
    const { RedisQueueAdapter } = require('./queueRedis');
    return new RedisQueueAdapter();
  }
  return new InMemoryQueueAdapter();
}

function ensureAdapter(): IQueueAdapter {
  if (!adapter) {
    adapter = pickAdapter();
    // Start the adapter (worker loop, GC timers, Redis subscriptions).
    const started = adapter.start();
    adapterStarting = started instanceof Promise ? started : Promise.resolve(started);
  }
  return adapter;
}

// ── Public API ──────────────────────────────────────────────────────────────

export const jobQueueService = {
  /** True when the in-memory adapter is in use (no Redis configured). */
  isMemoryMode(): boolean {
    return CONFIG.QUEUE_DRIVER === 'memory';
  },

  /** Enqueue a new download job. */
  async createJob(req: DownloadRequest): Promise<JobProgress> {
    const a = ensureAdapter();
    await adapterStarting;
    return a.enqueue(req);
  },

  /** Fetch a job's current snapshot. */
  async getJob(jobId: string): Promise<JobProgress | null> {
    const a = ensureAdapter();
    await adapterStarting;
    return a.get(jobId);
  },

  /** Cancel a queued or running job. */
  async cancelJob(jobId: string): Promise<boolean> {
    const a = ensureAdapter();
    await adapterStarting;
    return a.cancel(jobId);
  },

  /** Subscribe to live progress events. Returns an unsubscribe function. */
  subscribe(jobId: string, listener: JobListener): () => void {
    const a = ensureAdapter();
    // Note: subscribe is synchronous on the in-memory adapter, but the Redis
    // adapter uses pub/sub which only fires after the worker publishes — so
    // callers should also call getJob() once to get the current snapshot
    // before subscribing (the routes already do this).
    return a.subscribe(jobId, listener);
  },

  /** Replay events for reconnecting clients (Last-Event-ID). */
  async replayEvents(jobId: string, sinceSeq = 0): Promise<JobProgress[]> {
    const a = ensureAdapter();
    await adapterStarting;
    if (typeof a.replayEvents === 'function') {
      return a.replayEvents(jobId, sinceSeq);
    }
    return [];
  },

  /** Counts for /health and /metrics. */
  getStats(): { totalJobs: number; activeJobs: number; queuedJobs: number } {
    if (!adapter) return { totalJobs: 0, activeJobs: 0, queuedJobs: 0 };
    const s = adapter.stats();
    return { totalJobs: s.total, activeJobs: s.active, queuedJobs: s.queued };
  },

  /** Graceful shutdown — kill workers, close Redis connections. */
  async shutdown(): Promise<void> {
    if (adapter) {
      await adapter.shutdown();
      adapter = null;
      adapterStarting = null;
    }
    storageService.stopGcTimer();
  },
};

// Boot the storage service on first import (idempotent).
storageService.startGcTimer();

// Re-export the types so existing imports like
//   `import { jobQueueService, JobProgress } from '../services/jobQueue.service'`
// keep working.
export type { JobProgress, JobListener, DownloadRequest, IQueueAdapter } from './queue.types';
