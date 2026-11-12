import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';
import fs from 'fs';
import { jobQueueService } from '../services/jobQueue.service';
import { validateAndSanitizeUrl, assertPublicUrl } from '../utils/sanitizer';
import { sanitizeFilename } from '../utils/sanitizer';
import {
  downloadStartSchema,
  downloadCreateSchema,
  downloadProgressSchema,
  downloadFileSchema,
  downloadCancelSchema,
} from '../schemas';
import { ErrorCode, buildApiError, DEFAULT_MESSAGES } from '../utils/errors';
import { CONFIG } from '../config';
import { issueDownloadToken, verifyDownloadToken } from '../utils/tokens';
import { downloadStarted } from '../services/metrics.service';
import type { DownloadRequest, JobProgress } from '../services/queue.types';
import { checkQuota, recordBandwidth } from '../services/quota.service';
import { verifyTurnstileToken } from '../utils/turnstile';
import { storageService } from '../services/storage.service';
import { isLiveChannel, probeDirectSource, resolvePublicDocumentUrl } from '../services/source-discovery';
import { PublicTargetError } from '../services/proxy.service';
import { estimateSizeBytes } from '../services/job-runner';

/**
 * Download API surface.
 *
 * Endpoints:
 *
 *   GET  /api/download/start         (legacy) — translate querystring into a download request
 *   POST /api/download               (canonical) — accept a structured body
 *   GET  /api/download/progress      — SSE stream with heartbeat + Last-Event-ID resume
 *   GET  /api/download/ws            — WebSocket (JSON-RPC-ish) bidirectional channel
 *   GET  /api/download/file          — gated file stream (requires signed token)
 *   POST /api/download/cancel        — cancel a job
 */

interface DownloadStartQuery {
  url: string;
  height?: string;
  fps?: string;
  format_id?: string;
  type?: 'video' | 'audio';
  audioFormat?: 'mp3' | 'm4a' | 'flac' | 'wav' | 'aac' | 'opus';
  title?: string;
  duration?: string;
}

/** Convert the legacy GET querystring shape into the canonical DownloadRequest. */
function legacyQueryToRequest(q: DownloadStartQuery): DownloadRequest {
  const duration = q.duration ? parseFloat(q.duration) : undefined;
  return {
    url: q.url,
    sanitizedUrl: q.url, // validated by caller
    meta: q.title || duration ? { title: q.title, duration } : undefined,
    format: {
      kind: q.type === 'audio' ? 'audio' : 'video',
      height: q.height ? parseInt(q.height, 10) : undefined,
      fps: q.fps ? parseInt(q.fps, 10) : undefined,
      format_id: q.format_id,
      audioFormat: q.audioFormat,
    },
  };
}

export async function downloadRoute(fastify: FastifyInstance, _opts: FastifyPluginOptions) {
  // ── GET /api/download/start (legacy) ──────────────────────────────────────
  fastify.get<{ Querystring: DownloadStartQuery }>(
    '/download/start',
    { schema: downloadStartSchema, preHandler: verifyTurnstileToken },
    async (request, reply) => {
      const requestId = (request as any).id as string | undefined;
      const q = request.query;
      const ssrfCheck = await assertPublicUrl(q.url);
      if (!ssrfCheck.isValid) {
        return reply.status(400).send(
          buildApiError(ErrorCode.INVALID_URL, ssrfCheck.error, { requestId })
        );
      }

      const clientIp = request.ip || '127.0.0.1';
      const quota = await checkQuota(clientIp);
      if (!quota.allowed) {
        return reply.status(429).send(
          buildApiError(ErrorCode.RATE_LIMITED, 'Daily download bandwidth quota exceeded for your IP address.', { requestId })
        );
      }

      const req = legacyQueryToRequest({ ...q, url: ssrfCheck.sanitizedUrl });
      const job = await jobQueueService.createJob(req);
      downloadStarted.inc({ platform: job.platform || 'unknown', type: req.format.kind });

      const token = issueDownloadToken(job.jobId);
      return reply.status(202).send({
        status: 'queued',
        jobId: job.jobId,
        downloadFilename: job.downloadFilename,
        downloadToken: token,
        contentType: job.contentType,
      });
    }
  );

  // ── POST /api/download (canonical) ─────────────────────────────────────────
  fastify.post<{ Body: Omit<DownloadRequest, 'format'> & { format?: DownloadRequest['format'] } }>(
    '/download',
    { schema: downloadCreateSchema, preHandler: verifyTurnstileToken },
    async (request, reply) => {
      const requestId = (request as any).id as string | undefined;
      const body = request.body;
      const ssrfCheck = await assertPublicUrl(body.url);
      if (!ssrfCheck.isValid) {
        return reply.status(400).send(
          buildApiError(ErrorCode.INVALID_URL, ssrfCheck.error, { requestId })
        );
      }
      const clientIp = request.ip || '127.0.0.1';
      const quota = await checkQuota(clientIp);
      if (!quota.allowed) {
        return reply.status(429).send(
          buildApiError(ErrorCode.RATE_LIMITED, 'Daily download bandwidth quota exceeded for your IP address.', { requestId })
        );
      }

      const sanitizedUrl = ssrfCheck.sanitizedUrl;
      const detected = !body.format && (isLiveChannel(sanitizedUrl) ||
        await probeDirectSource(resolvePublicDocumentUrl(sanitizedUrl)).catch((err: unknown) => err instanceof PublicTargetError ? err : null));
      if (detected instanceof PublicTargetError) {
        return reply.status(400).send(buildApiError(ErrorCode.INVALID_URL, detected.message, { requestId }));
      }
      const req: DownloadRequest = {
        url: sanitizedUrl, sanitizedUrl, meta: body.meta,
        cancellable: body.cancellable,
        format: body.format || { kind: detected ? 'original' : 'video' },
      };

      // The original-file worker checks the actual Content-Length.
      if (req.format.kind !== 'original' && req.meta?.duration) {
        const estimatedBytes = estimateSizeBytes(req.format, req.meta.duration);
        if (estimatedBytes > 0 && !storageService.hasSpaceFor(estimatedBytes)) {
          return reply.status(413).send(
            buildApiError(ErrorCode.DISK_FULL, DEFAULT_MESSAGES[ErrorCode.DISK_FULL], { requestId })
          );
        }
      }

      const job = await jobQueueService.createJob(req);
      downloadStarted.inc({ platform: job.platform || 'unknown', type: req.format.kind });

      const token = issueDownloadToken(job.jobId);
      return reply.status(202).send({
        status: 'queued',
        jobId: job.jobId,
        downloadFilename: job.downloadFilename,
        downloadToken: token,
        contentType: job.contentType,
      });
    }
  );

  // ── GET /api/download/progress (SSE) ──────────────────────────────────────
  fastify.get<{ Querystring: { jobId: string; lastEventId?: string } }>(
    '/download/progress',
    { schema: downloadProgressSchema },
    async (request, reply) => {
      const requestId = (request as any).id as string | undefined;
      const { jobId, lastEventId } = request.query;

      const initialJob = await jobQueueService.getJob(jobId);
      if (!initialJob) {
        return reply.status(404).send(
          buildApiError(ErrorCode.JOB_NOT_FOUND, DEFAULT_MESSAGES[ErrorCode.JOB_NOT_FOUND], { requestId })
        );
      }

      const reqOrigin = request.headers.origin as string;
      const allowOrigin = reqOrigin && CONFIG.ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : CONFIG.ALLOWED_ORIGINS[0] || '*';

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': allowOrigin,
        'X-Accel-Buffering': 'no', // disable Nginx buffering
      });

      let eventSeq = 0;

      // Helper: write one SSE event with an `id:` line for resume support.
      const writeEvent = (data: JobProgress) => {
        try {
          reply.raw.write(`id: ${eventSeq}\n`);
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
          eventSeq++;
        } catch {
          // socket already closed
        }
      };

      // Helper: write a comment-line heartbeat. Does NOT count as an event,
      // so it does not increment `eventSeq`. Most proxies will keep the
      // connection alive as long as *any* byte flows every ~30s.
      const writeHeartbeat = () => {
        try { reply.raw.write(`: ping\n\n`); } catch {}
      };

      // Replay missed events if the client provided a Last-Event-ID.
      if (lastEventId !== undefined) {
        const sinceSeq = parseInt(lastEventId, 10);
        if (!isNaN(sinceSeq)) {
          const missedEvents = await jobQueueService.replayEvents(jobId, sinceSeq);
          for (const evt of missedEvents) {
            writeEvent(evt);
          }
        }
      }

      // Send the initial snapshot
      writeEvent(initialJob);

      // Subscribe to live updates
      const unsubscribe = jobQueueService.subscribe(jobId, (data) => {
        writeEvent(data);
        if (data.status === 'ready' || data.status === 'error' || data.status === 'cancelled') {
          unsubscribe();
          try { reply.raw.end(); } catch {}
        }
      });

      // Heartbeat every 15s — keeps the connection alive through proxies.
      const heartbeatTimer = setInterval(writeHeartbeat, CONFIG.SSE_HEARTBEAT_MS);
      heartbeatTimer.unref?.();

      request.raw.on('close', () => {
        clearInterval(heartbeatTimer);
        unsubscribe();
      });
    }
  );

  // ── GET /api/download/ws (WebSocket) ───────────────────────────────────────
  // Bidirectional JSON channel: subscribe / cancel / ping.
  // Bound via @fastify/websocket — see index.ts for registration.
  fastify.get('/download/ws', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const query = request.query as { jobId?: string };
    const jobId = query.jobId || '';

    let unsubscribe: (() => void) | null = null;
    let heartbeatTimer: NodeJS.Timeout | undefined;

    const send = (obj: any) => {
      try { socket.send(JSON.stringify(obj)); } catch {}
    };

    const writeHeartbeat = () => send({ kind: 'ping', ts: Date.now() });

    socket.on('message', async (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { send({ kind: 'error', error: 'invalid JSON' }); return; }

      if (msg.kind === 'subscribe' || (msg.kind === 'ping' && jobId && !unsubscribe)) {
        const targetJobId = msg.jobId || jobId;
        if (!targetJobId) {
          send({ kind: 'error', error: 'jobId required' });
          return;
        }

        // Send the current snapshot first
        const initial = await jobQueueService.getJob(targetJobId);
        if (!initial) {
          send({ kind: 'error', code: 'JOB_NOT_FOUND', message: 'Job not found.' });
          return;
        }
        send({ kind: 'progress', data: initial });

        if (unsubscribe) unsubscribe();
        unsubscribe = jobQueueService.subscribe(targetJobId, (data) => {
          send({ kind: 'progress', data });
          if (data.status === 'ready' || data.status === 'error' || data.status === 'cancelled') {
            send({ kind: data.status === 'ready' ? 'done' : 'failed', data });
            if (unsubscribe) { unsubscribe(); unsubscribe = null; }
            try { socket.close(); } catch {}
          }
        });

        // Heartbeat
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(writeHeartbeat, 25_000);
        heartbeatTimer.unref?.();
        return;
      }

      if (msg.kind === 'cancel') {
        const targetJobId = msg.jobId || jobId;
        if (!targetJobId) { send({ kind: 'error', error: 'jobId required' }); return; }
        const success = await jobQueueService.cancelJob(targetJobId);
        send({ kind: 'cancelled', ok: success });
        return;
      }

      if (msg.kind === 'ping') {
        send({ kind: 'pong', ts: Date.now() });
        return;
      }

      send({ kind: 'error', error: `unknown kind: ${msg.kind}` });
    });

    socket.on('close', () => {
      if (unsubscribe) unsubscribe();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    });

    socket.on('error', () => {
      if (unsubscribe) unsubscribe();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    });
  });

  // ── POST /api/download/cancel ──────────────────────────────────────────────
  fastify.post<{ Body: { jobId: string } }>(
    '/download/cancel',
    { schema: downloadCancelSchema },
    async (request, reply) => {
      const requestId = (request as any).id as string | undefined;
      const { jobId } = request.body;
      const success = await jobQueueService.cancelJob(jobId);
      if (!success) {
        return reply.status(404).send(
          buildApiError(ErrorCode.JOB_NOT_FOUND, DEFAULT_MESSAGES[ErrorCode.JOB_NOT_FOUND], { requestId })
        );
      }
      return reply.send({ status: 'success', message: 'Job cancelled successfully.' });
    }
  );

  // ── GET /api/download/file (gated by signed token) ─────────────────────────
  fastify.get<{ Querystring: { jobId: string; token: string } }>(
    '/download/file',
    { schema: downloadFileSchema },
    async (request, reply) => {
      const requestId = (request as any).id as string | undefined;
      const { jobId, token } = request.query;

      const verify = verifyDownloadToken(token, jobId);
      if (!verify.ok) {
        const code = verify.reason === 'expired' ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID;
        return reply.status(401).send(
          buildApiError(code, DEFAULT_MESSAGES[code], { requestId })
        );
      }

      const job = await jobQueueService.getJob(jobId);
      if (!job || job.status !== 'ready' || !job.filePath) {
        return reply.status(400).send(
          buildApiError(ErrorCode.JOB_NOT_FOUND, 'File is not ready or session expired.', { requestId })
        );
      }

      let fileStream: import('stream').Readable;
      try {
        fileStream = await storageService.getFileStream(job.filePath);
      } catch (err) {
        return reply.status(404).send(
          buildApiError(ErrorCode.JOB_NOT_FOUND, 'File is no longer available on storage.', { requestId })
        );
      }

      let fileSize = 0;
      if (fs.existsSync(job.filePath)) {
        try {
          fileSize = fs.statSync(job.filePath).size;
          void recordBandwidth(request.ip || '127.0.0.1', fileSize);
        } catch {}
      }

      const downloadFilename = sanitizeFilename(job.downloadFilename || 'media.mp4');
      const asciiFilename = downloadFilename.replace(/[^\w\s.-]/g, '_');

      // The queue owns the file lifetime; another subscriber or retry may
      // still need this artifact until the ready job expires.
      const replyObj = reply
        .type(job.contentType || 'video/mp4')
        .header('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`)
        .header('Access-Control-Allow-Origin', '*')
        .header('Access-Control-Expose-Headers', 'Content-Disposition');

      if (fileSize > 0) {
        replyObj.header('Content-Length', fileSize);
      }

      return replyObj.send(fileStream);
    }
  );

  // ── POST /api/gallery/download (Batch Images into ZIP) ────────────────────
  fastify.post<{ Body: { title?: string; images: import('../services/gallery.service').GalleryItem[] } }>(
    '/gallery/download',
    { preHandler: verifyTurnstileToken, schema: {
      body: {
        type: 'object', required: ['images'],
        properties: {
          title: { type: 'string', maxLength: 200 },
          images: { type: 'array', minItems: 1, maxItems: 50, items: {
            type: 'object', required: ['url', 'filename'],
            properties: { url: { type: 'string', maxLength: 2048 }, filename: { type: 'string', maxLength: 240 } },
          } },
        },
      },
    } },
    async (request, reply) => {
      const requestId = (request as any).id as string | undefined;
      const { title, images } = request.body || {};

      if (!images || !Array.isArray(images) || images.length === 0) {
        return reply.status(400).send(buildApiError(ErrorCode.INVALID_PARAMETER, 'No images provided for gallery download.', { requestId }));
      }

      const zipId = 'gallery_' + require('crypto').randomBytes(8).toString('hex');
      const safeTitle = sanitizeFilename(title || 'gallery');
      const zipFilename = `${safeTitle}_${Date.now()}.zip`;
      const zipPath = require('path').join(CONFIG.TEMP_DIR, `${zipId}.zip`);

      const { downloadGalleryZip } = await import('../services/gallery.service');

      try {
        await downloadGalleryZip(images, zipPath);
        const token = issueDownloadToken(zipId);

        return reply.status(200).send({
          status: 'ready',
          zipId,
          downloadFilename: zipFilename,
          downloadToken: token,
          totalImages: images.length,
          fileUrl: `/api/gallery/file?zipId=${zipId}&token=${token}&filename=${encodeURIComponent(zipFilename)}`,
        });
      } catch (err: any) {
        await fs.promises.unlink(zipPath).catch(() => {});
        return reply.status(422).send(buildApiError(ErrorCode.EXTRACTION_FAILED, 'No usable archive could be built from these gallery links.', { requestId }));
      }
    }
  );

  // ── GET /api/gallery/file (Stream Gallery ZIP) ─────────────────────────────
  fastify.get<{ Querystring: { zipId: string; token: string; filename?: string } }>(
    '/gallery/file',
    async (request, reply) => {
      const requestId = (request as any).id as string | undefined;
      const { zipId, token, filename } = request.query || {};
      if (!/^gallery_[a-f0-9]{16}$/.test(zipId || '')) {
        return reply.status(400).send(buildApiError(ErrorCode.INVALID_PARAMETER, 'Invalid gallery download ID.', { requestId }));
      }

      const tokenCheck = verifyDownloadToken(token, zipId);
      if (!tokenCheck.ok) {
        const code = tokenCheck.reason === 'expired' ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID;
        return reply.status(401).send(buildApiError(code, DEFAULT_MESSAGES[code], { requestId }));
      }

      const zipPath = require('path').join(CONFIG.TEMP_DIR, `${zipId}.zip`);
      if (!fs.existsSync(zipPath)) {
        return reply.status(404).send(buildApiError(ErrorCode.JOB_NOT_FOUND, 'Gallery ZIP file expired or not found.', { requestId }));
      }

      const stat = fs.statSync(zipPath);
      const downloadName = sanitizeFilename(filename || `${zipId}.zip`);

      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Length', stat.size.toString());
      reply.header('Content-Disposition', `attachment; filename="${downloadName}"`);
      reply.header('Access-Control-Allow-Origin', '*');

      const stream = fs.createReadStream(zipPath);
      stream.on('close', () => {
        try { fs.unlinkSync(zipPath); } catch {}
      });

      return reply.send(stream);
    }
  );

  // ── POST /api/cobalt/stream (Direct High-Speed Stream Resolution) ───────────
  fastify.post<{
    Body: {
      url: string;
      quality?: 'max' | '1080' | '720' | '480' | '360';
      isAudioOnly?: boolean;
      audioFormat?: 'mp3' | 'opus' | 'wav';
    };
  }>(
    '/cobalt/stream',
    async (request, reply) => {
      const requestId = (request as any).id as string | undefined;
      const { url, quality, isAudioOnly, audioFormat } = request.body || {};

      if (!url) {
        return reply.status(400).send(buildApiError(ErrorCode.INVALID_URL, 'URL is required.', { requestId }));
      }

      try {
        const { getCobaltDirectStream } = await import('../services/cobalt.service');
        const streamData = await getCobaltDirectStream(url, quality, isAudioOnly, audioFormat);
        return reply.status(200).send({
          status: 'success',
          directUrl: streamData.url,
          filename: streamData.filename,
        });
      } catch (err: any) {
        return reply.status(500).send(
          buildApiError(ErrorCode.INTERNAL, err.message || 'Failed to resolve stream via Cobalt.', { requestId })
        );
      }
    }
  );
}
