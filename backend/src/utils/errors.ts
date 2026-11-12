/**
 * Structured, machine-readable error codes returned by every API endpoint.
 *
 * The frontend should switch on `code` (stable contract) and use `message`
 * only for display (mutable). Adding a new code is a backwards-compatible
 * change; renaming an existing code is a breaking change.
 */
export const ErrorCode = {
  // ── URL / input ────────────────────────────────────────────────────────────
  INVALID_URL: 'INVALID_URL',
  MISSING_PARAMETER: 'MISSING_PARAMETER',
  INVALID_PARAMETER: 'INVALID_PARAMETER',

  // ── Video / source ──────────────────────────────────────────────────────────
  VIDEO_UNAVAILABLE: 'VIDEO_UNAVAILABLE',
  VIDEO_PRIVATE: 'VIDEO_PRIVATE',
  VIDEO_GEO_BLOCKED: 'VIDEO_GEO_BLOCKED',
  VIDEO_AGE_RESTRICTED: 'VIDEO_AGE_RESTRICTED',
  VIDEO_COPYRIGHT: 'VIDEO_COPYRIGHT',
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',

  // ── Job / queue ──────────────────────────────────────────────────────────────
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  JOB_EXPIRED: 'JOB_EXPIRED',
  QUEUE_FULL: 'QUEUE_FULL',
  DISK_FULL: 'DISK_FULL',
  DUPLICATE_JOB: 'DUPLICATE_JOB',

  // ── Auth ─────────────────────────────────────────────────────────────────────
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  API_KEY_INVALID: 'API_KEY_INVALID',
  BOT_VERIFICATION_FAILED: 'BOT_VERIFICATION_FAILED',

  // ── Transport ───────────────────────────────────────────────────────────────
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  // ── Internal ─────────────────────────────────────────────────────────────────
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

/**
 * Classification of error codes that are *retryable* at the job level.
 *
 * Used by:
 *  - BullMQ `attempts` + `backoff` to decide whether to re-queue a failed job.
 *  - The in-memory queue adapter's manual retry loop.
 *  - The frontend, to show a "Retry" button vs. a permanent-failure message.
 */
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.RATE_LIMITED,
  ErrorCode.EXTRACTION_FAILED,
  ErrorCode.QUEUE_FULL,
  ErrorCode.DISK_FULL,
  ErrorCode.INTERNAL,
]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/**
 * Map an internal / yt-dlp / ffmpeg error message to a stable ErrorCode.
 *
 * yt-dlp's stderr contains human-readable strings; we pattern-match on the
 * most common ones. The mapping is intentionally conservative — when in
 * doubt, fall through to `EXTRACTION_FAILED` / `INTERNAL` so the user
 * sees an honest "something went wrong" rather than a wrong specific code.
 */
export function classifyYtDlpError(rawError: string): ErrorCode {
  const msg = (rawError || '').toLowerCase();

  if (msg.includes('unavailable') || msg.includes('not found') || msg.includes('does not exist')) {
    return ErrorCode.VIDEO_UNAVAILABLE;
  }
  if (msg.includes('private') || msg.includes('members-only') || msg.includes('members only')) {
    return ErrorCode.VIDEO_PRIVATE;
  }
  if (msg.includes('copyright') || msg.includes('removed') || msg.includes('taken down')) {
    return ErrorCode.VIDEO_COPYRIGHT;
  }
  if (msg.includes('sign in') || msg.includes('age-restricted') || msg.includes('age restricted') || msg.includes('login required')) {
    return ErrorCode.VIDEO_AGE_RESTRICTED;
  }
  if (msg.includes('geo') || msg.includes('region') || msg.includes('not available in your country')) {
    return ErrorCode.VIDEO_GEO_BLOCKED;
  }
  if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit')) {
    return ErrorCode.RATE_LIMITED;
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return ErrorCode.INTERNAL;
  }

  return ErrorCode.EXTRACTION_FAILED;
}

/**
 * Build a consistent JSON error body.
 *
 * Shape:
 *   {
 *     "status": "error",
 *     "code": "VIDEO_UNAVAILABLE",     ← stable contract
 *     "message": "This video is unavailable.",  ← display string
 *     "requestId": "ab12cd34-...",     ← always present, also in X-Request-Id
 *     "retryable": false               ← derived from code via RETRYABLE_CODES
 *   }
 */
export interface ApiError {
  status: 'error';
  code: ErrorCode;
  message: string;
  requestId?: string;
  retryable: boolean;
  detail?: string; // only attached when NODE_ENV=development
}

export function buildApiError(
  code: ErrorCode,
  message: string,
  opts: { requestId?: string; detail?: string } = {}
): ApiError {
  return {
    status: 'error',
    code,
    message,
    requestId: opts.requestId,
    retryable: isRetryable(code),
    detail: process.env.NODE_ENV === 'development' ? opts.detail : undefined,
  };
}

/**
 * Default user-friendly messages per code. Routes may override these with
 * more specific text when the context warrants it.
 */
export const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.INVALID_URL]: 'The provided URL is invalid or unsupported.',
  [ErrorCode.MISSING_PARAMETER]: 'A required parameter is missing.',
  [ErrorCode.INVALID_PARAMETER]: 'One or more request parameters are invalid.',
  [ErrorCode.VIDEO_UNAVAILABLE]: 'This video is unavailable, private, or deleted.',
  [ErrorCode.VIDEO_PRIVATE]: 'This video is private or members-only.',
  [ErrorCode.VIDEO_GEO_BLOCKED]: 'This video is geo-restricted in your region.',
  [ErrorCode.VIDEO_AGE_RESTRICTED]: 'This video is age-restricted or requires sign-in.',
  [ErrorCode.VIDEO_COPYRIGHT]: 'This video is restricted due to copyright or removal.',
  [ErrorCode.EXTRACTION_FAILED]: 'Extraction failed. Please check the URL and try again.',
  [ErrorCode.JOB_NOT_FOUND]: 'Job not found or has expired.',
  [ErrorCode.JOB_EXPIRED]: 'This job has expired. Please start a new download.',
  [ErrorCode.QUEUE_FULL]: 'The download queue is full. Please try again shortly.',
  [ErrorCode.DISK_FULL]: 'Server storage is full. Please try again later.',
  [ErrorCode.DUPLICATE_JOB]: 'A job for this URL and quality is already in progress.',
  [ErrorCode.TOKEN_INVALID]: 'Download token is invalid.',
  [ErrorCode.TOKEN_EXPIRED]: 'Download token has expired. Please start a new download.',
  [ErrorCode.API_KEY_INVALID]: 'API key is missing or invalid.',
  [ErrorCode.BOT_VERIFICATION_FAILED]: 'Cloudflare Turnstile bot verification failed.',
  [ErrorCode.RATE_LIMITED]: 'Rate limit exceeded. Please slow down.',
  [ErrorCode.PAYLOAD_TOO_LARGE]: 'The requested file is too large to process.',
  [ErrorCode.INTERNAL]: 'An internal error occurred. Please try again.',
};
