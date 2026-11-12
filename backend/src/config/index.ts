import path from 'path';

function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

/**
 * EasySave backend configuration.
 *
 * Every knob that an operator might reasonably want to tune is exposed here and
 * overridable via environment variables.
 */
export const CONFIG = {
  DIRECT_DOWNLOAD_MAX_BYTES: boundedNumber('DIRECT_DOWNLOAD_MAX_MB', 512, 1, 8192) * 1024 * 1024,
  LIVE_RECORD_SECONDS: boundedNumber('LIVE_RECORD_SECONDS', 60, 15, 600),
  ARIA2_CONNECTIONS: boundedNumber('ARIA2_CONNECTIONS', 8, 1, 16),
  // ── Server ──────────────────────────────────────────────────────────────────
  PORT: parseInt(process.env.PORT ?? '3002', 10),
  HOST: process.env.HOST ?? '0.0.0.0',
  IS_DEV: process.env.NODE_ENV !== 'production',
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  TRUSTED_PROXIES: (process.env.TRUSTED_PROXIES ?? [
    '127.0.0.1', '::1',
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
    // Cloudflare IPv4 CIDR blocks
    '173.245.48.0/20', '103.21.244.0/22', '103.31.4.0/22', '141.101.64.0/18',
    '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22',
    '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14',
    '172.64.0.0/13', '131.0.72.0/22',
    // Cloudflare IPv6 CIDR blocks
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
    '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
  ].join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ── Storage ──────────────────────────────────────────────────────────────────
  TEMP_DIR: path.resolve(process.cwd(), process.env.TEMP_DIR ?? 'temp'),
  // Hard cap on the temp directory. When exceeded, oldest files are evicted first.
  TEMP_DIR_MAX_BYTES: parseInt(process.env.TEMP_DIR_MAX_BYTES ?? String(8 * 1024 * 1024 * 1024), 10), // 8 GB
  // Disk space we must keep free system-wide before starting a new job.
  DISK_RESERVED_MB: parseInt(process.env.DISK_RESERVED_MB ?? '1024', 10), // 1 GB

  // ── Job Queue & Concurrency ─────────────────────────────────────────────────
  /**
   * `redis`  → BullMQ-backed queue. State lives in Redis. Survives restarts.
   *            Multiple workers share one queue. Required for PM2 cluster mode.
   * `memory` → In-process Map-based queue. Default when REDIS_URL is unset.
   *            Zero external dependencies. Single-instance only.
   */
  QUEUE_DRIVER: (process.env.QUEUE_DRIVER ?? (process.env.REDIS_URL ? 'redis' : 'memory')) as 'redis' | 'memory',

  REDIS_URL: process.env.REDIS_URL ?? '', // e.g. redis://localhost:6379
  REDIS_QUEUE_NAME: process.env.REDIS_QUEUE_NAME ?? 'easysave:downloads',
  REDIS_CACHE_PREFIX: process.env.REDIS_CACHE_PREFIX ?? 'easysave:cache:',
  REDIS_DEDUPE_PREFIX: process.env.REDIS_DEDUPE_PREFIX ?? 'easysave:dedupe:',
  REDIS_PUBSUB_CHANNEL: process.env.REDIS_PUBSUB_CHANNEL ?? 'easysave:events',

  MAX_CONCURRENT_JOBS: parseInt(process.env.MAX_CONCURRENT_JOBS ?? '5', 10),
  JOB_EXPIRY_MS: 30 * 60 * 1000, // 30 minutes — job metadata TTL
  TEMP_FILE_MAX_AGE_MS: 20 * 60 * 1000, // 20 minutes — orphan file TTL
  CLEANUP_INTERVAL_MS: 10 * 60 * 1000, // 10 minutes — GC sweep cadence
  SSE_HEARTBEAT_MS: 15 * 1000, // 15 seconds — keep SSE alive through proxies
  SSE_EVENT_BUFFER_SIZE: 100, // per-job ring buffer for Last-Event-ID replay

  // ── Retry Policy ────────────────────────────────────────────────────────────
  DOWNLOAD_MAX_ATTEMPTS: parseInt(process.env.DOWNLOAD_MAX_ATTEMPTS ?? '3', 10),
  DOWNLOAD_BACKOFF_BASE_MS: parseInt(process.env.DOWNLOAD_BACKOFF_BASE_MS ?? '4000', 10),
  DOWNLOAD_BACKOFF_MAX_MS: 60 * 1000, // 60 s cap on a single backoff delay

  // ── Extraction Cache ─────────────────────────────────────────────────────────
  CACHE_TTL_MS: 30 * 60 * 1000, // 30 minutes
  CACHE_MAX_ENTRIES: 500,

  // ── Process Timeouts ────────────────────────────────────────────────────────
  EXTRACTION_TIMEOUT_MS: 40 * 1000, // 40 s for yt-dlp --dump-json
  DOWNLOAD_TIMEOUT_MS: 15 * 60 * 1000, // 15 min per download

  // ── Download Tokens ──────────────────────────────────────────────────────────
  /**
   * HMAC secret used to sign short-lived download tokens. MUST be set in production.
   * If unset, a per-process random secret is generated (tokens do not survive restart).
   */
  FILE_TOKEN_SECRET: process.env.FILE_TOKEN_SECRET ?? '',
  FILE_TOKEN_TTL_MS: 10 * 60 * 1000, // 10 min — lifetime of a /api/download/file token

  // ── yt-dlp / ffmpeg ─────────────────────────────────────────────────────────
  YTDLP_PATH: process.env.YTDLP_PATH ?? '',
  FFMPEG_PATH: process.env.FFMPEG_PATH ?? '',
  COOKIES_FILE_PATH: process.env.COOKIES_FILE_PATH ?? '',
  /**
   * Comma-separated list of HTTP(S) proxy URLs. When set, the backend
   * round-robins across them per job, so a single blocked proxy does not
   * kill the whole service. The selection is sticky per-job (same proxy
   * for retry attempts) to avoid flapping.
   */
  PROXY_URLS: (process.env.PROXY_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ── Rate Limiting ────────────────────────────────────────────────────────────
  RATE_LIMIT_HEALTH: parseInt(process.env.RATE_LIMIT_HEALTH ?? '600', 10),
  RATE_LIMIT_EXTRACT: parseInt(process.env.RATE_LIMIT_EXTRACT ?? '60', 10),
  RATE_LIMIT_DOWNLOAD_START: parseInt(process.env.RATE_LIMIT_DOWNLOAD_START ?? '30', 10),
  RATE_LIMIT_DOWNLOAD_PROGRESS: parseInt(process.env.RATE_LIMIT_DOWNLOAD_PROGRESS ?? '60', 10),
  RATE_LIMIT_DOWNLOAD_FILE: parseInt(process.env.RATE_LIMIT_DOWNLOAD_FILE ?? '60', 10),
  RATE_LIMIT_PROXY_STREAM: parseInt(process.env.RATE_LIMIT_PROXY_STREAM ?? '120', 10),
  RATE_LIMIT_GLOBAL: parseInt(process.env.RATE_LIMIT_GLOBAL ?? '240', 10),

  // ── Daily IP Quota ──────────────────────────────────────────────────────────
  DAILY_IP_BANDWIDTH_LIMIT_BYTES: parseInt(process.env.DAILY_IP_BANDWIDTH_LIMIT_BYTES ?? String(10 * 1024 * 1024 * 1024), 10), // 10 GB/day

  // ── API Key (optional) ───────────────────────────────────────────────────────
  /**
   * When API_KEYS env var is set, requests must include `X-Api-Key` header
   * matching one of the listed keys. When present, rate-limit buckets are
   * keyed by the API key instead of the client IP (useful for shared-NAT users).
   */
  API_KEYS: (process.env.API_KEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ── Bot Protection ─────────────────────────────────────────────────────────
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY ?? '',

  // ── Cobalt Engine (v10 API) ──────────────────────────────────────────────────
  COBALT_API_URL: (process.env.COBALT_API_URL ?? '').replace(/\/+$/, ''), // e.g. https://api.cobalt.tools or http://localhost:9000
  COBALT_API_KEY: process.env.COBALT_API_KEY ?? '',
  COBALT_ENABLED: process.env.COBALT_ENABLED !== 'false', // Enabled by default; falls back to yt-dlp automatically

  // ── Storage Driver ──────────────────────────────────────────────────────────
  STORAGE_DRIVER: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
  AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? '',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  AWS_S3_BUCKET: process.env.AWS_S3_BUCKET ?? 'easysave-storage',
  AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? '',
  AWS_S3_FORCE_PATH_STYLE: process.env.AWS_S3_FORCE_PATH_STYLE === 'true',
} as const;

/** Whether API-key authentication is enabled. */
export const API_AUTH_ENABLED = CONFIG.API_KEYS.length > 0;

/**
 * Resolve the secret used to sign download tokens.
 * In dev / single-instance: a per-process random secret fallback is allowed.
 * In production: the operator MUST set FILE_TOKEN_SECRET or boot fails.
 */
export function getFileTokenSecret(): string {
  if (CONFIG.FILE_TOKEN_SECRET) return CONFIG.FILE_TOKEN_SECRET;
  if (!CONFIG.IS_DEV) {
    // eslint-disable-next-line no-console
    console.error(
      '[CONFIG] FATAL ERROR: FILE_TOKEN_SECRET environment variable is missing in production mode (NODE_ENV=production). Server boot aborted (process.exit(1)) to prevent token validation failures across cluster workers.'
    );
    process.exit(1);
  }
  if (!fileTokenFallback) {
    fileTokenFallback = cryptoRandomString(48);
  }
  return fileTokenFallback;
}

// Early boot validation for production mode
if (!CONFIG.IS_DEV && !CONFIG.FILE_TOKEN_SECRET) {
  // eslint-disable-next-line no-console
  console.error(
    '[CONFIG] FATAL ERROR: FILE_TOKEN_SECRET environment variable is missing in production mode (NODE_ENV=production). Server boot aborted (process.exit(1)).'
  );
  process.exit(1);
}

let fileTokenFallback: string | undefined;

function cryptoRandomString(len: number): string {
  const { randomBytes } = require('crypto') as typeof import('crypto');
  return randomBytes(len).toString('base64url');
}
