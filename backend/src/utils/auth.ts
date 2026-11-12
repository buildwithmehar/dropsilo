import type { FastifyRequest, FastifyReply } from 'fastify';
import { CONFIG, API_AUTH_ENABLED } from '../config';
import { ErrorCode, buildApiError, DEFAULT_MESSAGES } from './errors';
import { generateRequestId } from './requestId';

/**
 * Pluggable authentication + identification hooks.
 *
 * Two responsibilities:
 *   1. Verify `X-Api-Key` header when `API_KEYS` env var is set.
 *   2. Return the rate-limit key for this request — IP by default, API key
 *      when present (so shared-NAT users do not share the IP bucket).
 *
 * Plus a small helper to attach a request ID to every request for log correlation.
 */

export function getRateLimitKey(req: FastifyRequest): string {
  const apiKey = (req.headers['x-api-key'] as string) || '';
  if (apiKey && CONFIG.API_KEYS.includes(apiKey)) {
    return `apikey:${apiKey.slice(0, 8)}`;
  }
  // trustProxy is true, so req.ip is the real client IP (X-Forwarded-For)
  return `ip:${req.ip}`;
}

export function attachRequestId(req: FastifyRequest, _reply: FastifyReply, done: () => void) {
  const existing = (req.headers['x-request-id'] as string) || '';
  const reqId = existing && /^[a-zA-Z0-9_-]{4,64}$/.test(existing) ? existing : generateRequestId();
  (req as any).id = reqId;
  _reply.header('X-Request-Id', reqId);
  done();
}

export function requireApiKey(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  if (!API_AUTH_ENABLED) {
    done();
    return;
  }
  const apiKey = (req.headers['x-api-key'] as string) || '';
  if (!apiKey || !CONFIG.API_KEYS.includes(apiKey)) {
    const requestId = (req as any).id as string | undefined;
    reply.status(401).send(buildApiError(ErrorCode.API_KEY_INVALID, DEFAULT_MESSAGES[ErrorCode.API_KEY_INVALID], { requestId }));
    return;
  }
  done();
}
