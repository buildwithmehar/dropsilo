import fs from 'node:fs';
import { CONFIG } from '../config';
import { storageService } from './storage.service';
import { runDownloadJob, JobFailure } from './job-runner';
import { isRetryable, ErrorCode } from '../utils/errors';
import { computeDedupeKey } from '../utils/requestId';
import type { DownloadRequest, IQueueAdapter, JobProgress, JobListener } from './queue.types';
import { downloadRetries, downloadCompleted, downloadFailed, downloadCancelled, observeQueueStats } from './metrics.service';

/**
 * In-process queue adapter — the default when REDIS_URL is not configured.
 *
 * Implementation notes:
 *   - Single-flight dedupe via `dedupe:<key> → jobId` map.
 *   - Exponential backoff via setTimeout (capped at DOWNLOAD_BACKOFF_MAX_MS).
 *   - Per-job child-process handle for cancellation via SIGTERM.
 *   - Per-job ring buffer (size SSE_EVENT_BUFFER_SIZE) of the last N events
 *     so SSE clients can resume via Last-Event-ID.
 *   - All long-lived timers call `.unref()` so the process can exit cleanly.
 *
 * This is the **fallback** adapter. For multi-instance / PM2 cluster deployments,
 * set `REDIS_URL` to switch to the Redis-backed adapter.
 */

interface InternalJob {
  meta: JobProgress;
  request: DownloadRequest;
  dedupeKey: string;
  listeners: Set<JobListener>;
  eventBuffer: JobProgress[]; // ring buffer for Last-Event-ID replay
  controller?: AbortController;
  cancelled: boolean;
  createdAt: number;
  attempt: number;
  backoffTimer?: NodeJS.Timeout;
}

export class InMemoryQueueAdapter implements IQueueAdapter {
  private jobs = new Map<string, InternalJob>();
  private dedupeIndex = new Map<string, string>(); // dedupeKey → jobId
  private pending: string[] = [];
  private activeCount = 0;
  private gcTimer?: NodeJS.Timeout;

  async start(): Promise<void> {
    // Periodic GC: purge expired jobs + orphan files
    this.gcTimer = setInterval(() => this.runGc(), CONFIG.CLEANUP_INTERVAL_MS);
    this.gcTimer.unref?.();
    setImmediate(() => this.runGc());

    // Periodic metrics refresh
    const metricsTimer = setInterval(() => this.refreshMetrics(), 5_000);
    metricsTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    for (const job of this.jobs.values()) {
      job.controller?.abort();
      if (job.backoffTimer) clearTimeout(job.backoffTimer);
    }
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

    // Check dedupe
    const existingJobId = this.dedupeIndex.get(dedupeKey);
    if (existingJobId) {
      const existing = this.jobs.get(existingJobId);
      if (existing && !['error', 'cancelled'].includes(existing.meta.status) &&
          (existing.meta.status !== 'ready' ? !req.cancellable : (!!existing.meta.filePath &&
            Date.now() - existing.meta.updatedAt < CONFIG.FILE_TOKEN_TTL_MS &&
            (storageService.driverName !== 'local' || fs.existsSync(existing.meta.filePath))))) {
        // If the existing job is ready, return it (caller can fetch the file).
        // Otherwise, return the existing job's snapshot — frontend will subscribe
        // to the same jobId for progress.
        return existing.meta;
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

    const job: InternalJob = {
      meta: initialMeta,
      request: req,
      dedupeKey,
      listeners: new Set(),
      eventBuffer: [initialMeta],
      cancelled: false,
      createdAt: now,
      attempt: 1,
    };

    this.jobs.set(jobId, job);
    if (!req.cancellable) this.dedupeIndex.set(dedupeKey, jobId);
    this.pending.push(jobId);
    this.processQueue();
    return initialMeta;
  }

  async get(jobId: string): Promise<JobProgress | null> {
    return this.jobs.get(jobId)?.meta ?? null;
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.meta.status === 'ready' || job.meta.status === 'error') return false;
    if (job.cancelled) return true;
    job.cancelled = true;
    const pendingIndex = this.pending.indexOf(jobId);
    if (pendingIndex !== -1) this.pending.splice(pendingIndex, 1);
    job.controller?.abort();
    if (job.backoffTimer) clearTimeout(job.backoffTimer);
    const cancelledMeta: JobProgress = {
      ...job.meta,
      status: 'cancelled',
      error: 'Job was cancelled by user.',
      updatedAt: Date.now(),
    };
    job.meta = cancelledMeta;
    this.notify(jobId, cancelledMeta);
    downloadCancelled.inc({ platform: job.meta.platform || 'unknown' });
    return true;
  }

  subscribe(jobId: string, listener: JobListener): () => void {
    const job = this.jobs.get(jobId);
    if (!job) return () => {};
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  /** Replay the last N events for a reconnecting SSE client. */
  replayEvents(jobId: string, sinceSeq: number): JobProgress[] {
    const job = this.jobs.get(jobId);
    if (!job) return [];
    // The eventBuffer is appended in order, so we filter by index.
    // `sinceSeq` is the index of the last event the client already saw.
    return job.eventBuffer.slice(sinceSeq + 1);
  }

  stats() {
    return {
      total: this.jobs.size,
      active: this.activeCount,
      queued: this.pending.length,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private processQueue = () => {
    while (this.activeCount < CONFIG.MAX_CONCURRENT_JOBS && this.pending.length > 0) {
      const jobId = this.pending.shift();
      if (jobId && this.jobs.has(jobId)) {
        this.activeCount++;
        void this.startAttempt(jobId, 1);
      }
    }
    this.refreshMetrics();
  };

  private startAttempt(jobId: string, attempt: number) {
    const job = this.jobs.get(jobId);
    if (!job || job.cancelled) {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.processQueue();
      return;
    }

    job.attempt = attempt;
    job.meta.attempt = attempt;
    if (attempt > 1) {
      job.meta.status = 'retrying';
      this.notify(jobId, { ...job.meta, updatedAt: Date.now() });
      downloadRetries.inc({ platform: job.meta.platform || 'unknown' });
    }

    job.controller = new AbortController();

    const emit = (partial: Partial<JobProgress>, force = false) => {
      if (job.cancelled) return;
      const prev = job.meta;
      let newPercent = partial.percent !== undefined ? partial.percent : prev.percent;
      // Enforce monotonic percentage
      newPercent = Number(Math.min(100, Math.max(prev.percent, newPercent)).toFixed(1));

      const updated: JobProgress = {
        ...prev,
        ...partial,
        percent: newPercent,
        updatedAt: Date.now(),
      };
      job.meta = updated;
      job.eventBuffer.push(updated);
      if (job.eventBuffer.length > CONFIG.SSE_EVENT_BUFFER_SIZE) {
        job.eventBuffer.shift();
      }
      // Throttle: at most one event per 200ms unless force=true or stage/status changed
      const now = Date.now();
      const stageChanged = partial.stage !== undefined && partial.stage !== prev.stage;
      const statusChanged = partial.status !== undefined && partial.status !== prev.status;
      if (force || stageChanged || statusChanged || now - prev.updatedAt >= 200) {
        this.notify(jobId, updated);
      }
    };

    runDownloadJob(
      { jobId, attempt, request: job.request, abortSignal: job.controller.signal },
      emit
    )
      .then((result) => {
        job.controller = undefined;
        this.activeCount = Math.max(0, this.activeCount - 1);

        if (result.status === 'cancelled' || job.cancelled) {
          if (result.filePath) storageService.unlinkIfExists(result.filePath);
          this.processQueue();
          return;
        }

        const finalMeta: JobProgress = {
          ...job.meta,
          status: 'ready',
          percent: 100,
          stage: 'finalizing',
          filePath: result.filePath,
          downloadFilename: result.downloadFilename,
          contentType: result.contentType,
          updatedAt: Date.now(),
        };
        job.meta = finalMeta;
        if (job.request.cancellable) this.dedupeIndex.set(job.dedupeKey, jobId);
        this.notify(jobId, finalMeta);
        downloadCompleted.inc({ platform: job.meta.platform || 'unknown', type: job.request.format.kind });
        this.processQueue();
      })
      .catch((failure: JobFailure) => {
        job.controller = undefined;
        this.activeCount = Math.max(0, this.activeCount - 1);

        // If user cancelled during the run, do not retry.
        if (job.cancelled) {
          this.processQueue();
          return;
        }

        const canRetry = isRetryable(failure.code) && attempt < CONFIG.DOWNLOAD_MAX_ATTEMPTS;
        if (canRetry) {
          const backoff = Math.min(
            CONFIG.DOWNLOAD_BACKOFF_MAX_MS,
            CONFIG.DOWNLOAD_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
          );
          job.meta.status = 'retrying';
          job.meta.error = `Attempt ${attempt} failed: ${failure.message}. Retrying in ${Math.round(backoff / 1000)}s...`;
          job.meta.errorCode = failure.code;
          this.notify(jobId, { ...job.meta, updatedAt: Date.now() });
          job.backoffTimer = setTimeout(() => {
            job.backoffTimer = undefined;
            this.startAttempt(jobId, attempt + 1);
          }, backoff);
          job.backoffTimer.unref?.();
          this.processQueue();
          return;
        }

        // Final failure
        const failedMeta: JobProgress = {
          ...job.meta,
          status: 'error',
          stage: 'finalizing',
          error: failure.message,
          errorCode: failure.code,
          updatedAt: Date.now(),
        };
        job.meta = failedMeta;
        this.notify(jobId, failedMeta);
        downloadFailed.inc({ platform: job.meta.platform || 'unknown', code: failure.code });
        this.processQueue();
      });
  }

  private notify(jobId: string, data: JobProgress) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    for (const fn of job.listeners) {
      try { fn(data); } catch {}
    }
  }

  private runGc() {
    const now = Date.now();
    for (const [jobId, job] of this.jobs.entries()) {
      const isFinished = ['ready', 'error', 'cancelled'].includes(job.meta.status);
      const expiryWindow = isFinished ? CONFIG.FILE_TOKEN_TTL_MS : CONFIG.JOB_EXPIRY_MS;
      if (now - job.meta.updatedAt > expiryWindow || now - job.createdAt > CONFIG.JOB_EXPIRY_MS) {
        job.controller?.abort();
        if (job.backoffTimer) clearTimeout(job.backoffTimer);
        if (job.meta.filePath) storageService.unlinkIfExists(job.meta.filePath);
        if (this.dedupeIndex.get(job.dedupeKey) === jobId) this.dedupeIndex.delete(job.dedupeKey);
        this.jobs.delete(jobId);
      }
    }
    storageService.runGc();
    this.refreshMetrics();
  }

  private refreshMetrics() {
    observeQueueStats({ queued: this.pending.length, active: this.activeCount });
  }
}
