import crypto from 'crypto';

/**
 * Generate a short, URL-safe request ID for log correlation.
 *
 * The shape is `req_<8 hex chars>` (~4 billion possibilities, collision-risk-free
 * at any realistic QPS for a single-process window of "in-flight requests").
 * A UUID is overkill for a request ID and adds visual noise to every log line.
 */
export function generateRequestId(): string {
  return 'req_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Pick a proxy URL round-robin from the configured list.
 *
 * The selection is *sticky per job* — for a given `jobId`, the same proxy
 * is always returned. This is intentional: if a job fails because the
 * proxy was rate-limited, retrying with the same proxy gives the
 * rate-limit time to clear. Switching proxies on every retry would
 * actually flap faster and trigger more aggressive bot detection.
 *
 * However, when a job is *re-enqueued* (different retry attempt, same
 * jobId), we DO want to switch proxies — otherwise we'd hammer the
 * same blocked proxy forever. The caller passes `attempt` to control this.
 */
export function pickProxyForJob(jobId: string, attempt = 0): string | undefined {
  const proxies = require('../config').CONFIG.PROXY_URLS as string[];
  if (!proxies || proxies.length === 0) return undefined;

  // Stable hash of (jobId + attempt) → index
  const hash = crypto.createHash('sha256').update(`${jobId}:${attempt}`).digest();
  const idx = hash.readUInt32BE(0) % proxies.length;
  return proxies[idx];
}

/**
 * Hash a download request to its deduplication key.
 *
 * Two requests with the same URL + format produce the same dedupeKey,
 * so the queue layer can return the existing jobId instead of spawning
 * a duplicate yt-dlp process.
 */
export function computeDedupeKey(params: {
  url: string;
  format_id?: string;
  type?: string;
  audioFormat?: string;
  height?: number;
  fps?: number;
  vcodec?: string;
  hdr?: boolean;
  subtitles?: boolean;
  thumbnail?: boolean;
}): string {
  const normalized = JSON.stringify({
    url: params.url,
    format_id: params.format_id ?? '',
    type: params.type ?? 'video',
    audioFormat: params.audioFormat ?? '',
    height: params.height ?? 0,
    fps: params.fps ?? 0,
    vcodec: params.vcodec ?? '',
    hdr: params.hdr ?? false,
    subtitles: params.subtitles ?? false,
    thumbnail: params.thumbnail ?? false,
  });
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
