import { Queue, Worker, QueueEvents } from 'bullmq';
import fs from 'node:fs';
import IORedis from 'ioredis';
import { CONFIG } from '../config';
import { storageService } from './storage.service';
import { runDownloadJob, JobFailure } from './job-runner';
import { isRetryable } from '../utils/errors';
import { computeDedupeKey } from '../utils/requestId';
import type { DownloadRequest, IQueueAdapter, JobProgress, JobListener } from './queue.types';
import {
  downloadRetries,
  downloadCompleted,
  downloadFailed,
  downloadCancelled,
  observeQueueStats,
} from './metrics.service';

/**
 * Redis-backed queue adapter using BullMQ.
 *
 * Why this exists:
 *   - In-memory queue breaks under PM2 cluster mode (each worker has its own queue).
 *   - BullMQ stores queue state + active jobs in Redis, so N workers all share one queue.
 *   - BullMQ also gives us: atomic dequeue, automatic retry with backoff, job
 *     priorities, delayed jobs, dead-letter queue, rate-limiting per worker,
 *     and a built-in admin UI (bullboard) — all for free.
 *
 * Cross-worker progress broadcast:
 *   - The worker that *owns* a job publishes events on a Redis Pub/Sub channel
 *     (`REDIS_PUBSUB_CHANNEL`).
 *   - Any worker — including the one that does not own the job — can subscribe
 *     to that channel and forward events to its own SSE / WS clients.
 *   - This is the critical mechanism that makes `/api/download/progress`
 *     work no matter which PM2 worker the client's HTTP request lands on.
 */

interface RedisJobState {
  jobId: string;
  request: DownloadRequest;
  meta: JobProgress;
  dedupeKey: string;
  createdAt: number;
  attempt: number;
  cancelled: boolean;
}

const STATES_KEY = 'easysave:job_states'; // hash: jobId → JSON state
const DEDUPE_KEY = 'easysave:dedupe'; // hash: dedupeKey → jobId

export class RedisQueueAdapter implements IQueueAdapter {
  private connection: IORedis;
  private pubsub: IORedis;
  private queue: Queue;
  private worker?: Worker;
  private queueEvents?: QueueEvents;
  private listeners = new Map<string, Set<JobListener>>();
  private statesCache = new Map<string, RedisJobState>();
  private eventBuffers = new Map<string, JobProgress[]>();
  private gcTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;

  private activeJobs = new Map<string, AbortController>();

  constructor() {
    if (!CONFIG.REDIS_URL) {
      throw new Error('REDIS_URL must be set when QUEUE_DRIVER=redis');
    }
    this.connection = new IORedis(CONFIG.REDIS_URL, { maxRetriesPerRequest: null });
    this.pubsub = new IORedis(CONFIG.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue(CONFIG.REDIS_QUEUE_NAME, { connection: this.connection.duplicate() });
  }

  async start(): Promise<void> {
    // Subscribe to Pub/Sub for cross-worker progress events & cancel signals
    await this.pubsub.subscribe(CONFIG.REDIS_PUBSUB_CHANNEL);
    this.pubsub.on('message', (_channel, raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.kind === 'progress' && msg.jobId && msg.data) {
          this.handleProgressFromPubSub(msg.jobId, msg.data as JobProgress);
        } else if (msg.kind === 'cancel' && msg.jobId) {
          this.activeJobs.get(msg.jobId)?.abort();
        }
      } catch {}
    });

    // Start the BullMQ worker (this process will pick up jobs from the queue)
    this.worker = new Worker(
      CONFIG.REDIS_QUEUE_NAME,
      async (bullJob) => {
        const jobId = bullJob.id ?? '';
        const request = bullJob.data.request as DownloadRequest;
        const attempt = (bullJob.attemptsMade ?? 0) + 1;
        await this.executeJobInWorker(jobId, request, attempt);
      },
      {
        connection: this.connection.duplicate(),
        concurrency: CONFIG.MAX_CONCURRENT_JOBS,
      }
    );

    // Listen for global job events (failure, completed) for metrics + cleanup
    this.queueEvents = new QueueEvents(CONFIG.REDIS_QUEUE_NAME, {
      connection: this.connection.duplicate(),
    });
    this.queueEvents.on('failed', ({ jobId, failedReason, prev }) => {
      // BullMQ emits `failed` after all retries are exhausted (or on non-retryable).
      // `attemptsMade` is not in the event payload type for v5, but it's available
      // via the Job instance if needed; we use `prev` to detect final failures.
      void prev;
      const state = this.statesCache.get(jobId);
      if (state) {
        const code = (failedReason as any)?.code || 'EXTRACTION_FAILED';
        downloadFailed.inc({ platform: state.meta.platform || 'unknown', code });
        // Mark in Redis so other workers see the failure
        state.meta.status = 'error';
        state.meta.error = (failedReason as any)?.message || failedReason;
        state.meta.errorCode = code;
        void this.persistState(state);
        this.publishProgress(jobId, state.meta);
      }
    });

    this.gcTimer = setInterval(() => this.runGc(), CONFIG.CLEANUP_INTERVAL_MS);
    this.gcTimer.unref?.();

    this.metricsTimer = setInterval(() => this.refreshMetrics(), 5_000);
    this.metricsTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    for (const controller of this.activeJobs.values()) controller.abort();
    if (this.worker) await this.worker.close();
    if (this.queueEvents) await this.queueEvents.close();
    await this.queue.close();
    this.connection.disconnect();
    this.pubsub.disconnect();
  }

  async enqueue(req: DownloadRequest): Promise<JobProgress> {
    const dedupeKey = computeDedupeKey({
      url: req.sanitizedUrl || req.url,
      format_id: req.format.format_id,
      type: req.format.kind,
      audioFormat: req.format.audioFormat,
      height: req.format.height,
      fps: req.format.fps,
      vcodec: req.format.vcodec,
      hdr: req.format.hdr,
      subtitles: req.format.subtitles,
      thumbnail: req.format.thumbnail,
    });

    // Check dedupe via Redis HGET
    const existingJobId = await this.connection.hget(DEDUPE_KEY, dedupeKey);
    if (existingJobId) {
      const stateRaw = await this.connection.hget(STATES_KEY, existingJobId);
      if (stateRaw) {
        try {
          const state = JSON.parse(stateRaw) as RedisJobState;
          if (state.meta.status !== 'error' && state.meta.status !== 'cancelled' &&
              (state.meta.status !== 'ready' ? !req.cancellable : (!!state.meta.filePath &&
                Date.now() - state.meta.updatedAt < CONFIG.FILE_TOKEN_TTL_MS &&
                (storageService.driverName !== 'local' || fs.existsSync(state.meta.filePath))))) {
            this.statesCache.set(existingJobId, state);
            return state.meta;
          }
        } catch {}
      }
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const now = Date.now();
    const initialMeta: JobProgress = {
      jobId,
      attempt: 1,
      maxAttempts: CONFIG.DOWNLOAD_MAX_ATTEMPTS,
      status: 'queued',
      percent: 0,
      speed: '',
      eta: '',
      stage: 'downloading',
      downloadFilename: '',
      contentType: req.format.kind === 'audio' ? 'audio/mpeg' : 'video/mp4',
      platform: req.platform,
      dedupeKey,
      createdAt: now,
      updatedAt: now,
    };

    const state: RedisJobState = {
      jobId,
      request: req,
      meta: initialMeta,
      dedupeKey,
      createdAt: now,
      attempt: 1,
      cancelled: false,
    };

    this.statesCache.set(jobId, state);
    await this.connection.hset(STATES_KEY, jobId, JSON.stringify(state));
    if (!req.cancellable) await this.connection.hset(DEDUPE_KEY, dedupeKey, jobId);

    // Enqueue in BullMQ with retry policy.
    // BullMQ handles backoff automatically when configured on the Queue.
    await this.queue.add(jobId, { request: req, dedupeKey }, {
      jobId,
      attempts: CONFIG.DOWNLOAD_MAX_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: CONFIG.DOWNLOAD_BACKOFF_BASE_MS,
      },
      removeOnComplete: { age: 3600, count: 1000 }, // keep last 1000 or 1h
      removeOnFail: { age: 3600 },
    });

    return initialMeta;
  }

  async get(jobId: string): Promise<JobProgress | null> {
    // Check local cache first (this worker may be running the job)
    const cached = this.statesCache.get(jobId);
    if (cached) return cached.meta;

    // Otherwise, read from Redis (job may be owned by another worker)
    const raw = await this.connection.hget(STATES_KEY, jobId);
    if (!raw) return null;
    try {
      const state = JSON.parse(raw) as RedisJobState;
      this.statesCache.set(jobId, state);
      return state.meta;
    } catch {
      return null;
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    const state = this.statesCache.get(jobId) ?? (await this.get(jobId) ? JSON.parse((await this.connection.hget(STATES_KEY, jobId))!) : null);
    if (!state) {
      // Try to read raw state
      const raw = await this.connection.hget(STATES_KEY, jobId);
      if (!raw) return false;
      try {
        this.statesCache.set(jobId, JSON.parse(raw));
      } catch {
        return false;
      }
    }
    const s = this.statesCache.get(jobId);
    if (!s || s.meta.status === 'ready' || s.meta.status === 'error') return false;
    if (s.cancelled) return true;

    s.cancelled = true;
    s.meta.status = 'cancelled';
    s.meta.error = 'Job was cancelled by user.';
    s.meta.updatedAt = Date.now();
    await this.persistState(s);
    this.publishProgress(jobId, s.meta);
    downloadCancelled.inc({ platform: s.meta.platform || 'unknown' });

    // Broadcast cancellation signal to all cluster workers via PubSub
    try {
      await this.connection.publish(
        CONFIG.REDIS_PUBSUB_CHANNEL,
        JSON.stringify({ kind: 'cancel', jobId })
      );
    } catch {}

    // Kill local active child process if present on this node
    this.activeJobs.get(jobId)?.abort();

    // Best-effort: remove the BullMQ job from queue
    try { await this.queue.remove(jobId); } catch {}
    return true;
  }

  subscribe(jobId: string, listener: JobListener): () => void {
    if (!this.listeners.has(jobId)) {
      this.listeners.set(jobId, new Set());
    }
    const set = this.listeners.get(jobId)!;
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(jobId);
    };
  }

  async replayEvents(jobId: string, sinceSeq = 0): Promise<JobProgress[]> {
    const eventsKey = `easysave:events:${jobId}`;
    try {
      const list = await this.connection.lrange(eventsKey, 0, -1);
      if (list && list.length > 0) {
        const parsed = list.map((raw) => JSON.parse(raw) as JobProgress);
        return parsed.slice(sinceSeq);
      }
    } catch {}
    const buf = this.eventBuffers.get(jobId) ?? [];
    return buf.slice(sinceSeq);
  }

  stats() {
    // Note: these are *local* listener counts. For accurate queue stats in a
    // multi-worker deployment, call `queue.getJobCounts()` instead — but that
    // is an async round-trip, so we don't do it here on every /health call.
    return {
      total: this.statesCache.size,
      active: 0, // owned by some worker — queryable via queue.getJobCounts()
      queued: 0,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Execute a BullMQ job inside *this* worker process.
   *
   * This is called by the BullMQ Worker callback. The job runs to completion
   * (or failure). Progress events are emitted locally AND published to Redis
   * so other workers' SSE/WS listeners can forward them.
   */
  private async executeJobInWorker(jobId: string, request: DownloadRequest, attempt: number) {
    let state = this.statesCache.get(jobId);
    if (!state) {
      const raw = await this.connection.hget(STATES_KEY, jobId);
      if (!raw) throw new Error(`No state for job ${jobId}`);
      state = JSON.parse(raw) as RedisJobState;
      this.statesCache.set(jobId, state);
    }

    if (state.cancelled) {
      // BullMQ will treat this as success; the cancelled state is already in Redis.
      return;
    }

    state.attempt = attempt;
    state.meta.attempt = attempt;
    if (attempt > 1) {
      state.meta.status = 'retrying';
      this.publishProgress(jobId, state.meta);
      downloadRetries.inc({ platform: state.meta.platform || 'unknown' });
    }

    const emit = (partial: Partial<JobProgress>, force = false) => {
      if (state!.cancelled) return;
      const prev = state!.meta;
      let newPercent = partial.percent !== undefined ? partial.percent : prev.percent;
      newPercent = Number(Math.min(100, Math.max(prev.percent, newPercent)).toFixed(1));

      const updated: JobProgress = {
        ...prev,
        ...partial,
        percent: newPercent,
        updatedAt: Date.now(),
      };
      state!.meta = updated;
      const now = Date.now();
      const stageChanged = partial.stage !== undefined && partial.stage !== prev.stage;
      const statusChanged = partial.status !== undefined && partial.status !== prev.status;
      if (force || stageChanged || statusChanged || now - prev.updatedAt >= 200) {
        this.publishProgress(jobId, updated);
      }
    };

    const controller = new AbortController();
    this.activeJobs.set(jobId, controller);

    try {
      const result = await runDownloadJob({ jobId, attempt, request, abortSignal: controller.signal }, emit);

      if (result.status === 'cancelled' || state.cancelled || controller.signal.aborted) {
        if (result.filePath) storageService.unlinkIfExists(result.filePath);
        // Don't update Redis with "ready" — the user already cancelled
        return;
      }

      state.meta.status = 'ready';
      state.meta.percent = 100;
      state.meta.stage = 'finalizing';
      state.meta.filePath = result.filePath;
      state.meta.downloadFilename = result.downloadFilename;
      state.meta.contentType = result.contentType;
      state.meta.updatedAt = Date.now();
      await this.persistState(state);
      if (request.cancellable) await this.connection.hset(DEDUPE_KEY, state.dedupeKey, jobId);
      this.publishProgress(jobId, state.meta);
      downloadCompleted.inc({ platform: state.meta.platform || 'unknown', type: request.format.kind });
    } catch (err: any) {
      if (state.cancelled || controller.signal.aborted) return;
      const failure = err as JobFailure;
      // BullMQ will retry based on the `attempts` config + our `backoff` setting.
      // We just need to mark the current state and re-throw so BullMQ handles the retry.
      state.meta.status = isRetryable(failure.code) && attempt < CONFIG.DOWNLOAD_MAX_ATTEMPTS ? 'retrying' : 'error';
      state.meta.error = failure.message;
      state.meta.errorCode = failure.code;
      state.meta.updatedAt = Date.now();
      await this.persistState(state);
      this.publishProgress(jobId, state.meta);

      if (state.meta.status === 'error' || !isRetryable(failure.code)) {
        // Non-retryable — don't let BullMQ waste more attempts
        return;
      }
      // Re-throw so BullMQ schedules the retry with our exponential backoff
      const e = new Error(failure.message) as any;
      e.code = failure.code;
      throw e;
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  private handleProgressFromPubSub(jobId: string, data: JobProgress) {
    // Update local cache
    let state = this.statesCache.get(jobId);
    if (state) {
      state.meta = data;
    } else {
      this.statesCache.set(jobId, {
        jobId,
        request: {} as any, // we don't have it locally; other worker owns the job
        meta: data,
        dedupeKey: data.dedupeKey || '',
        createdAt: data.createdAt,
        attempt: data.attempt,
        cancelled: data.status === 'cancelled',
      });
    }

    // Forward to local SSE / WS listeners
    const set = this.listeners.get(jobId);
    if (set) {
      for (const fn of set) {
        try { fn(data); } catch {}
      }
    }

    // Append to ring buffer
    const buf = this.eventBuffers.get(jobId) ?? [];
    buf.push(data);
    if (buf.length > CONFIG.SSE_EVENT_BUFFER_SIZE) buf.shift();
    this.eventBuffers.set(jobId, buf);
  }

  private async persistState(state: RedisJobState) {
    try {
      await this.connection.hset(STATES_KEY, state.jobId, JSON.stringify(state));
    } catch {}
  }

  private publishProgress(jobId: string, data: JobProgress) {
    // Local listeners
    const set = this.listeners.get(jobId);
    if (set) {
      for (const fn of set) {
        try { fn(data); } catch {}
      }
    }
    // Ring buffer
    const buf = this.eventBuffers.get(jobId) ?? [];
    buf.push(data);
    if (buf.length > CONFIG.SSE_EVENT_BUFFER_SIZE) buf.shift();
    this.eventBuffers.set(jobId, buf);
    // Cross-worker broadcast (best-effort; do not await)
    this.connection.publish(CONFIG.REDIS_PUBSUB_CHANNEL, JSON.stringify({ kind: 'progress', jobId, data })).catch(() => {});
    // Persist to Redis list for cross-worker Last-Event-ID replay
    const eventsKey = `easysave:events:${jobId}`;
    this.connection.rpush(eventsKey, JSON.stringify(data)).catch(() => {});
    this.connection.expire(eventsKey, 3600).catch(() => {});
  }

  private async runGc() {
    // Sweep expired states from Redis (older than JOB_EXPIRY_MS)
    const now = Date.now();
    const allStates = await this.connection.hgetall(STATES_KEY);
    for (const [jobId, raw] of Object.entries(allStates)) {
      try {
        const state = JSON.parse(raw) as RedisJobState;
        if (now - state.createdAt > CONFIG.JOB_EXPIRY_MS ||
            state.meta.status === 'ready' && now - state.meta.updatedAt > CONFIG.FILE_TOKEN_TTL_MS) {
          if (state.meta.filePath) storageService.unlinkIfExists(state.meta.filePath);
          await this.connection.hdel(STATES_KEY, jobId);
          await this.connection.eval(
            'if redis.call("HGET", KEYS[1], ARGV[1]) == ARGV[2] then return redis.call("HDEL", KEYS[1], ARGV[1]) end',
            1, DEDUPE_KEY, state.dedupeKey, jobId,
          );
          this.statesCache.delete(jobId);
          this.eventBuffers.delete(jobId);
        }
      } catch {}
    }
    storageService.runGc();
    this.refreshMetrics();
  }

  private async refreshMetrics() {
    try {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
      observeQueueStats({
        queued: counts.waiting + counts.delayed,
        active: counts.active,
      });
    } catch {}
  }
}
