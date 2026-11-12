import type { FastifyRequest, FastifyReply } from 'fastify';
import { CONFIG } from '../config';
import { ErrorCode, buildApiError } from './errors';

export async function verifyTurnstileToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const requestId = (request as any).id as string | undefined;
  const secretKey = CONFIG.TURNSTILE_SECRET_KEY;

  if (!secretKey) {
    if (CONFIG.IS_DEV) {
      request.log.warn({ reqId: requestId }, '[TURNSTILE] TURNSTILE_SECRET_KEY is not set. Skipping verification in dev mode.');
      return;
    }
    request.log.error({ reqId: requestId }, '[TURNSTILE] TURNSTILE_SECRET_KEY missing in production.');
    reply.status(403).send(
      buildApiError(ErrorCode.BOT_VERIFICATION_FAILED, 'Bot verification is mandatory in production but secret key is unconfigured.', { requestId })
    );
    return;
  }

  // Cloudflare official test keys — always pass (for staging/testing environments)
  const TEST_KEYS = [
    '1x0000000000000000000000000000000AA',
    '2x0000000000000000000000000000000AA',
  ];
  if (TEST_KEYS.includes(secretKey)) {
    request.log.warn({ reqId: requestId }, '[TURNSTILE] Test key detected — skipping verification.');
    return;
  }

  const body = (request.body as Record<string, any>) || {};
  const token =
    (request.headers['x-turnstile-token'] as string) ||
    body['cf-turnstile-response'] ||
    body['turnstileToken'];

  if (!token || typeof token !== 'string') {
    request.log.warn({ reqId: requestId }, '[TURNSTILE] Missing Turnstile token');
    reply.status(403).send(
      buildApiError(ErrorCode.BOT_VERIFICATION_FAILED, 'Turnstile token required (header X-Turnstile-Token or body turnstileToken).', { requestId })
    );
    return;
  }

  try {
    const remoteip = request.ip;
    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        secret: secretKey,
        response: token,
        remoteip,
      }),
    });

    if (!verifyRes.ok) {
      request.log.error({ reqId: requestId, status: verifyRes.status }, '[TURNSTILE] Siteverify API returned HTTP error');
      reply.status(403).send(
        buildApiError(ErrorCode.BOT_VERIFICATION_FAILED, 'Turnstile verification server error.', { requestId })
      );
      return;
    }

    const data = (await verifyRes.json()) as { success: boolean; 'error-codes'?: string[] };
    if (!data.success) {
      request.log.warn({ reqId: requestId, errors: data['error-codes'] }, '[TURNSTILE] Verification failed');
      reply.status(403).send(
        buildApiError(ErrorCode.BOT_VERIFICATION_FAILED, 'Bot verification failed. Please refresh and try again.', { requestId })
      );
      return;
    }

    request.log.info({ reqId: requestId }, '[TURNSTILE] Verification succeeded');
  } catch (err: any) {
    request.log.error({ reqId: requestId, err: err.message }, '[TURNSTILE] Exception during siteverify call');
    reply.status(403).send(
      buildApiError(ErrorCode.BOT_VERIFICATION_FAILED, 'Failed to verify bot challenge token.', { requestId, detail: err.message })
    );
    return;
  }
}
