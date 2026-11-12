/**
 * Shared job-progress types used by both queue adapters
 * (`InMemoryQueueAdapter` and `RedisQueueAdapter`) and by every route.
 *
 * The shape is the wire-format the frontend subscribes to over SSE / WS,
 * so it is treated as a public API contract — additive changes only.
 */

export type JobStatus =
  | 'queued'      // accepted into queue, waiting for a worker slot
  | 'starting'    // worker picked up the job, spawning yt-dlp
  | 'retrying'    // previous attempt failed, waiting for backoff before next attempt
  | 'downloading' // yt-dlp is downloading fragments
  | 'merging'     // ffmpeg is muxing video+audio (or transcoding audio)
  | 'ready'       // final file is on disk, ready to stream
  | 'error'       // exhausted retries (or non-retryable error)
  | 'cancelled';  // user cancelled

export type JobStage = 'downloading' | 'processing' | 'finalizing';

export interface JobProgress {
  jobId: string;
  attempt: number;          // 1-based. 1 = first attempt.
  maxAttempts: number;
  status: JobStatus;
  percent: number;          // 0..100, monotonic
  speed: string;            // e.g. "5.2 MB/s" — empty when not downloading
  eta: string;              // e.g. "2m 13s" — empty when not downloading
  stage: JobStage;
  downloadedSize?: string;
  totalSize?: string;
  error?: string;
  errorCode?: string;       // structured ErrorCode — see utils/errors.ts
  filePath?: string;        // absolute path on disk, only when status === 'ready'
  downloadFilename?: string;
  contentType?: string;
  platform?: string;
  dedupeKey?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DownloadRequest {
  url: string;
  sanitizedUrl?: string;
  platform?: string;
  cancellable?: boolean;
  format: {
    kind: 'video' | 'audio' | 'original';
    height?: number;
    fps?: number;
    format_id?: string;
    container?: 'mp4' | 'webm' | 'mkv' | 'm4a' | 'mp3' | 'flac' | 'wav' | 'aac' | 'opus';
    audioFormat?: 'mp3' | 'm4a' | 'flac' | 'wav' | 'aac' | 'opus';
    vcodec?: 'avc1' | 'vp9' | 'av1' | 'h264' | 'hevc';
    hdr?: boolean;
    subtitles?: boolean;            // --write-subs --embed-subs
    subtitleLangs?: string[];        // --sub-langs ISO language codes, e.g. ["en", "es"]
    thumbnail?: boolean;            // --write-thumbnail
    trim?: { start: string; end: string }; // --download-sections "*start-end"
    filenameTemplate?: string;      // yt-dlp -o template, e.g. "%(title)s.%(ext)s"
  };
  meta?: {
    title?: string;
    duration?: number;
  };
}

export type DownloadFormat = DownloadRequest['format'];

/**
 * Subscription listener receives a snapshot of `JobProgress` on every event.
 * Returns an unsubscribe function.
 */
export type JobListener = (data: JobProgress) => void;

/**
 * The queue adapter interface that both In-Memory and Redis implementations satisfy.
 *
 * The adapter is responsible for:
 *  - persisting job state (so it survives process restart, in the Redis case)
 *  - enforcing concurrency (MAX_CONCURRENT_JOBS)
 *  - retrying failed jobs with exponential backoff
 *  - broadcasting progress events to subscribers (in-process listeners for
 *    In-Memory, Redis Pub/Sub for Redis — the Redis adapter transparently
 *    routes messages back to the local listener registry)
 */
export interface IQueueAdapter {
  /** Start the worker loop (called once at boot). */
  start(): Promise<void> | void;

  /** Stop the worker loop and release resources (called on shutdown). */
  shutdown(): Promise<void> | void;

  /** Enqueue a new download job. Returns the initial JobProgress snapshot. */
  enqueue(req: DownloadRequest): Promise<JobProgress>;

  /** Fetch the current snapshot of a job. */
  get(jobId: string): Promise<JobProgress | null>;

  /** Cancel a running or queued job. */
  cancel(jobId: string): Promise<boolean>;

  /** Subscribe to live progress events for a job. Returns an unsubscribe fn. */
  subscribe(jobId: string, listener: JobListener): () => void;

  /** Replay historical events for SSE reconnection / Last-Event-ID. */
  replayEvents?(jobId: string, sinceSeq?: number): Promise<JobProgress[]> | JobProgress[];

  /** Counts for /health and /metrics. */
  stats(): { total: number; active: number; queued: number };
}
