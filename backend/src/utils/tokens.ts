import crypto from 'crypto';
import { CONFIG, getFileTokenSecret } from '../config';

/**
 * Short-lived, signed download tokens.
 *
 * Shape (URL-safe base64 of a JSON payload + HMAC-SHA256 signature):
 *
 *   <base64url(payload)>.<base64url(hmac)>
 *
 * Payload:
 *   { jobId: string, iat: number, exp: number }
 *
 * Why HMAC instead of JWT? We don't need the JWT claim-set complexity;
 * we just need (a) integrity, (b) expiry, (c) per-process secret.
 *
 * Why a token at all? Previously `/api/download/file?jobId=...` accepted a
 * raw jobId, which is guessable and leaked through server logs. The token
 * makes the URL unforgeable and gives us a clean revocation path.
 */

interface TokenPayload {
  jobId: string;
  iat: number;
  exp: number;
}

const TOKEN_TTL_MS = CONFIG.FILE_TOKEN_TTL_MS;

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function unb64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function sign(payload: TokenPayload): string {
  const secret = getFileTokenSecret();
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest();
  return `${body}.${sig.toString('base64url')}`;
}

function verify(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [body, sig] = parts;
  const secret = getFileTokenSecret();
  const expectedSig = crypto.createHmac('sha256', secret).update(body).digest('base64url');

  // Constant-time comparison to prevent timing attacks
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(unb64url(body).toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload.jobId !== 'string') return null;
  if (typeof payload.exp !== 'number') return null;
  if (Date.now() > payload.exp) return null;

  return payload;
}

/**
 * Issue a fresh download token bound to a specific jobId.
 * Token lifetime is bounded by `CONFIG.FILE_TOKEN_TTL_MS` (default 10 min).
 */
export function issueDownloadToken(jobId: string): string {
  const now = Date.now();
  const payload: TokenPayload = {
    jobId,
    iat: now,
    exp: now + TOKEN_TTL_MS,
  };
  return sign(payload);
}

export type VerifyResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad_signature' };

/**
 * Verify a download token and return the bound jobId on success.
 */
export function verifyDownloadToken(token: string, expectedJobId?: string): VerifyResult {
  const payload = verify(token);
  if (!payload) {
    // Distinguish "expired" from "bad sig" by attempting to decode the body
    // without verifying the signature.
    const [body] = token.split('.');
    if (!body) return { ok: false, reason: 'malformed' };
    try {
      const decoded = JSON.parse(unb64url(body).toString('utf8'));
      if (typeof decoded.exp === 'number' && Date.now() > decoded.exp) {
        return { ok: false, reason: 'expired' };
      }
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    return { ok: false, reason: 'bad_signature' };
  }

  if (expectedJobId && payload.jobId !== expectedJobId) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, jobId: payload.jobId };
}

/**
 * Random URL-safe opaque token used for API keys, request IDs, etc.
 */
export function randomToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}
