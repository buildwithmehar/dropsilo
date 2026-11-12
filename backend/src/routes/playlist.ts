import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import { finished } from 'node:stream/promises';
const { ZipArchive } = require('archiver');
import * as crypto from 'crypto';
import { assertPublicUrl } from '../utils/sanitizer';
import { expandPlaylistUrl } from '../services/ytdl-runner';
import { runDownloadJob } from '../services/job-runner';
import { playlistDownloadSchema, downloadFileSchema } from '../schemas';
import { ErrorCode, buildApiError } from '../utils/errors';
import { CONFIG } from '../config';
import { issueDownloadToken, verifyDownloadToken } from '../utils/tokens';
import { verifyTurnstileToken } from '../utils/turnstile';
import type { DownloadFormat, JobProgress } from '../services/queue.types';

interface PlaylistDownloadBody {
  url: string;
  items?: Array<{ url: string; title?: string }>;
  format?: DownloadFormat;
}

export interface BatchJobState {
  batchId: string;
  url: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  totalItems: number;
  completedItems: number;
  failedItems: number;
  overallPercent: number;
  zipFilePath?: string;
  zipFilename: string;
  error?: string;
  itemStatuses: Array<{ url: string; title?: string; status: string; percent: number }>;
}

const batchJobs = new Map<string, BatchJobState>();

export function getBatchJob(batchId: string): BatchJobState | undefined {
  return batchJobs.get(batchId);
}

export async function playlistRoute(fastify: FastifyInstance) {
  /**
   * POST /api/playlist/download
   * Body: { url: string, items?: Array<{ url: string, title?: string }>, format?: DownloadFormat }
   *
   * Queues a batch playlist download job. Downloads each item and packages them into a streaming .zip archive.
   */
  fastify.post<{ Body: PlaylistDownloadBody }>(
    '/playlist/download',
    { schema: playlistDownloadSchema, preHandler: verifyTurnstileToken },
    async (request: FastifyRequest<{ Body: PlaylistDownloadBody }>, reply: FastifyReply) => {
      const requestId = (request as any).id as string | undefined;
      const { url, items: inputItems, format } = request.body || {};

      const ssrfCheck = await assertPublicUrl(url);
      if (!ssrfCheck.isValid) {
        return reply.status(400).send(
          buildApiError(ErrorCode.INVALID_URL, ssrfCheck.error, { requestId })
        );
      }

      let itemsToDownload: Array<{ url: string; title?: string }> = inputItems || [];
      if (itemsToDownload.length === 0) {
        try {
          const expansion = await expandPlaylistUrl(ssrfCheck.sanitizedUrl);
          itemsToDownload = expansion.entries.map((e) => ({ url: e.url, title: e.title }));
        } catch (err: any) {
          return reply.status(400).send(
            buildApiError(ErrorCode.EXTRACTION_FAILED, 'Failed to expand playlist items.', {
              requestId,
              detail: err.message,
            })
          );
        }
      }

      if (itemsToDownload.length === 0) {
        return reply.status(400).send(
          buildApiError(ErrorCode.INVALID_PARAMETER, 'No valid items found in playlist.', { requestId })
        );
      }

      // Limit batch size to 50 items to prevent resource exhaustion
      const maxBatchItems = 50;
      if (itemsToDownload.length > maxBatchItems) {
        itemsToDownload = itemsToDownload.slice(0, maxBatchItems);
      }

      const batchId = 'batch_' + crypto.randomBytes(8).toString('hex');
      const zipFilename = `playlist_${Date.now()}.zip`;
      const batchState: BatchJobState = {
        batchId,
        url: ssrfCheck.sanitizedUrl,
        status: 'queued',
        totalItems: itemsToDownload.length,
        completedItems: 0,
        failedItems: 0,
        overallPercent: 0,
        zipFilename,
        itemStatuses: itemsToDownload.map((item) => ({
          url: item.url,
          title: item.title,
          status: 'queued',
          percent: 0,
        })),
      };

      batchJobs.set(batchId, batchState);
      const token = issueDownloadToken(batchId);

      // Process batch asynchronously in background
      processBatchJob(batchState, format || { kind: 'video' }, request.log).catch((err) => {
        request.log.error({ reqId: requestId, batchId, err: err.message }, '[PLAYLIST BATCH] Processing failed');
      });

      return reply.status(202).send({
        status: 'queued',
        batchId,
        downloadFilename: zipFilename,
        downloadToken: token,
        totalItems: itemsToDownload.length,
      });
    }
  );

  /**
   * GET /api/playlist/download/file?batchId=...&token=...
   * Streams the completed playlist .zip archive.
   */
  fastify.get<{ Querystring: { batchId: string; token: string } }>(
    '/playlist/download/file',
    { schema: downloadFileSchema },
    async (request, reply) => {
      const requestId = (request as any).id as string | undefined;
      const { batchId, token } = request.query || {};

      const tokenCheck = verifyDownloadToken(token, batchId);
      if (!tokenCheck.ok) {
        const code = tokenCheck.reason === 'expired' ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID;
        return reply.status(401).send(buildApiError(code, 'Invalid or expired download token.', { requestId }));
      }

      const batchState = batchJobs.get(batchId);
      if (!batchState) {
        return reply.status(404).send(buildApiError(ErrorCode.JOB_NOT_FOUND, 'Batch job not found.', { requestId }));
      }

      if (batchState.status !== 'completed' || !batchState.zipFilePath || !fs.existsSync(batchState.zipFilePath)) {
        return reply.status(400).send(
          buildApiError(ErrorCode.JOB_NOT_FOUND, `Batch download is not ready (status: ${batchState.status}).`, { requestId })
        );
      }

      const stat = fs.statSync(batchState.zipFilePath);
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Length', stat.size.toString());
      reply.header('Content-Disposition', `attachment; filename="${batchState.zipFilename}"`);

      const stream = fs.createReadStream(batchState.zipFilePath);
      return reply.send(stream);
    }
  );

  /**
   * GET /api/playlist/progress?batchId=...
   * SSE stream providing real-time overall batch status and item progress.
   */
  fastify.get<{ Querystring: { batchId: string } }>(
    '/playlist/progress',
    async (request, reply) => {
      const requestId = (request as any).id as string | undefined;
      const { batchId } = (request.query as { batchId: string }) || {};

      const batchState = batchJobs.get(batchId);
      if (!batchState) {
        return reply.status(404).send(buildApiError(ErrorCode.JOB_NOT_FOUND, 'Batch job not found.', { requestId }));
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });

      const sendState = () => {
        try {
          const current = batchJobs.get(batchId);
          if (current) {
            reply.raw.write(`data: ${JSON.stringify(current)}\n\n`);
          }
        } catch {}
      };

      sendState();

      const timer = setInterval(() => {
        const current = batchJobs.get(batchId);
        if (!current) {
          clearInterval(timer);
          try { reply.raw.end(); } catch {}
          return;
        }
        sendState();
        if (current.status === 'completed' || current.status === 'failed') {
          clearInterval(timer);
          setTimeout(() => {
            try { reply.raw.end(); } catch {}
          }, 1000);
        }
      }, 800);

      request.raw.on('close', () => {
        clearInterval(timer);
      });
    }
  );
}

async function processBatchJob(batchState: BatchJobState, format: DownloadFormat, logger: any): Promise<void> {
  batchState.status = 'processing';
  const batchDir = path.join(CONFIG.TEMP_DIR, batchState.batchId);
  if (!fs.existsSync(batchDir)) {
    fs.mkdirSync(batchDir, { recursive: true });
  }

  const downloadedFiles: string[] = [];
  const CONCURRENCY_LIMIT = 3;
  let activeIndex = 0;

  async function worker() {
    while (activeIndex < batchState.itemStatuses.length) {
      const i = activeIndex++;
      const item = batchState.itemStatuses[i];
      item.status = 'downloading';

      try {
        const ssrf = await assertPublicUrl(item.url);
        if (!ssrf.isValid) throw new Error(ssrf.error);

        const jobCtx = {
          jobId: `${batchState.batchId}_${i}`,
          attempt: 1,
          request: {
            url: item.url,
            sanitizedUrl: ssrf.sanitizedUrl,
            format,
            meta: { title: item.title },
          },
        };

        const res = await runDownloadJob(jobCtx, (partial: Partial<JobProgress>) => {
          if (typeof partial.percent === 'number') {
            item.percent = partial.percent;
            let sumPercent = 0;
            for (const st of batchState.itemStatuses) {
              sumPercent += st.percent;
            }
            batchState.overallPercent = Math.min(99, Math.floor(sumPercent / batchState.totalItems));
          }
        });

        if (res.filePath && fs.existsSync(res.filePath)) {
          const dest = path.join(batchDir, path.basename(res.filePath));
          fs.copyFileSync(res.filePath, dest);
          downloadedFiles.push(dest);
        }

        item.status = 'completed';
        item.percent = 100;
        batchState.completedItems++;
      } catch (err: any) {
        logger.warn({ batchId: batchState.batchId, url: item.url, err: err.message }, '[PLAYLIST ITEM] Download failed');
        item.status = 'failed';
        batchState.failedItems++;
      }

      let sumPercent = 0;
      for (const st of batchState.itemStatuses) {
        sumPercent += st.percent;
      }
      batchState.overallPercent = Math.floor(sumPercent / batchState.totalItems);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY_LIMIT, batchState.itemStatuses.length) }, () => worker());
  await Promise.all(workers);

  if (downloadedFiles.length === 0) {
    batchState.status = 'failed';
    batchState.error = 'All playlist items failed to download.';
    return;
  }

  // Create Zip Archive
  const zipFilePath = path.join(CONFIG.TEMP_DIR, `${batchState.batchId}.zip`);
  const output = fs.createWriteStream(zipFilePath);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', (error: Error) => output.destroy(error));
  const written = finished(output);
  archive.pipe(output);
  for (const file of downloadedFiles) {
    archive.file(file, { name: path.basename(file) });
  }
  await Promise.all([archive.finalize(), written]);

  batchState.zipFilePath = zipFilePath;
  batchState.status = 'completed';
  batchState.overallPercent = 100;

  // Cleanup temp item directory
  try {
    fs.rmSync(batchDir, { recursive: true, force: true });
  } catch {}
}
