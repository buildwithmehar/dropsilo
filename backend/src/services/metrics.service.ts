import client from 'prom-client';
import { CONFIG } from '../config';

/**
 * Prometheus metrics collection.
 *
 * Exposed via `GET /metrics` in Prometheus text format. The shape of every
 * metric is intentionally generic so a generic Grafana dashboard can be
 * pointed at any EasySave instance.
 */

const register = new client.Registry();
register.setDefaultLabels({ app: 'easysave-backend' });

/** Exposed so /metrics route can read `contentType` directly. */
export const metricsRegistry = register;

/** Render the metrics registry as Prometheus text. */
export async function metricsText(): Promise<string> {
  return register.metrics();
}

// ── Counters ────────────────────────────────────────────────────────────────
export const extractTotal = new client.Counter({
  name: 'easysave_extract_total',
  help: 'Total number of /api/extract requests received.',
  labelNames: ['platform'],
  registers: [register],
});

export const extractErrors = new client.Counter({
  name: 'easysave_extract_errors_total',
  help: 'Total number of failed /api/extract requests.',
  labelNames: ['platform', 'code'],
  registers: [register],
});

export const downloadStarted = new client.Counter({
  name: 'easysave_download_started_total',
  help: 'Total number of download jobs created.',
  labelNames: ['platform', 'type'],
  registers: [register],
});

export const downloadCompleted = new client.Counter({
  name: 'easysave_download_completed_total',
  help: 'Total number of download jobs that reached status=ready.',
  labelNames: ['platform', 'type'],
  registers: [register],
});

export const downloadFailed = new client.Counter({
  name: 'easysave_download_failed_total',
  help: 'Total number of download jobs that reached status=error.',
  labelNames: ['platform', 'code'],
  registers: [register],
});

export const downloadRetries = new client.Counter({
  name: 'easysave_download_retry_total',
  help: 'Total number of download job retry attempts.',
  labelNames: ['platform'],
  registers: [register],
});

export const downloadCancelled = new client.Counter({
  name: 'easysave_download_cancelled_total',
  help: 'Total number of download jobs cancelled by user.',
  labelNames: ['platform'],
  registers: [register],
});

// ── Gauges ──────────────────────────────────────────────────────────────────
export const queueDepth = new client.Gauge({
  name: 'easysave_queue_depth',
  help: 'Number of download jobs waiting in the queue.',
  registers: [register],
});

export const activeJobs = new client.Gauge({
  name: 'easysave_active_jobs',
  help: 'Number of download jobs currently executing.',
  registers: [register],
});

export const tempDirBytes = new client.Gauge({
  name: 'easysave_temp_dir_bytes',
  help: 'Total size of the temp directory in bytes.',
  registers: [register],
});

export const tempDirFiles = new client.Gauge({
  name: 'easysave_temp_dir_files',
  help: 'Total number of files in the temp directory.',
  registers: [register],
});

export const cacheEntries = new client.Gauge({
  name: 'easysave_cache_entries',
  help: 'Number of entries in the extraction cache.',
  registers: [register],
});

export const cacheHits = new client.Counter({
  name: 'easysave_cache_hits_total',
  help: 'Total extraction cache hits.',
  registers: [register],
});

export const cacheMisses = new client.Counter({
  name: 'easysave_cache_misses_total',
  help: 'Total extraction cache misses.',
  registers: [register],
});

// ── Histograms ──────────────────────────────────────────────────────────────
export const extractDuration = new client.Histogram({
  name: 'easysave_extract_duration_seconds',
  help: 'Wall-clock duration of /api/extract in seconds.',
  labelNames: ['platform', 'cache'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40],
  registers: [register],
});

export const downloadDuration = new client.Histogram({
  name: 'easysave_download_duration_seconds',
  help: 'Wall-clock duration of a download job in seconds (from queued to ready).',
  labelNames: ['platform', 'type'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 900],
  registers: [register],
});

// Default Node.js metrics (CPU, memory, event loop lag, GC)
client.collectDefaultMetrics({ register, prefix: 'easysave_node_' });

/** Optional: bump the gauges from a single timer instead of having every service poke them. */
export function observeQueueStats(opts: { queued: number; active: number }) {
  queueDepth.set(opts.queued);
  activeJobs.set(opts.active);
}

/** Convenience: wrap an async fn and observe its duration in a histogram. */
export async function timed<T>(
  histogram: client.Histogram<string>,
  labels: Record<string, string>,
  fn: () => Promise<T>
): Promise<T> {
  const end = histogram.startTimer(labels);
  try {
    return await fn();
  } finally {
    end();
  }
}

// Hint for type checker — CONFIG import avoids unused-import warning when
// the file is parsed in environments without prom-client installed yet.
export const _configRef = CONFIG;
