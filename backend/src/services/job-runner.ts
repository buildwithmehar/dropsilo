import { execFile, spawn, ChildProcess } from 'child_process';
import { createInterface } from 'node:readline';
import path from 'path';
import fs from 'fs';
import { CONFIG } from '../config';
import { getYtDlpPath } from './ytdl.service';
import { buildDownloadArgs, getCachedYouTubeDownloadInfo } from './ytdl-runner';
import { sanitizeFilename } from '../utils/sanitizer';
import { classifyYtDlpError, ErrorCode } from '../utils/errors';
import { storageService } from './storage.service';
import { isSpotifyUrl, getSpotifyInfo, downloadSpotifyTrackAudio } from './spotify.service';
import type { DownloadRequest, JobProgress, JobStage, JobStatus } from './queue.types';
import { runSourceDownload } from './source-download';

/**
 * The pure yt-dlp execution + progress-parsing loop, shared by both queue
 * adapters. Given a job description and an "emit" callback, this function:
 *
 *   1. Spawns yt-dlp with the appropriate argv (proxy, cookies, format spec).
 *   2. Parses stdout (yt-dlp JSON progress lines + ffmpeg `[Merger]` markers).
 *   3. Calls `emit(partial)` whenever progress changes.
 *   4. Resolves with `{ status: 'ready', filePath, ... }` on success.
 *   5. Rejects with `{ code, message }` on failure (caller decides whether to retry).
 *
 * This module has NO knowledge of the queue implementation — no Redis, no
 * BullMQ, no in-memory Map. Pure function of (job → events).
 */

export interface JobRunContext {
  jobId: string;
  attempt: number;       // 1-based
  request: DownloadRequest;
  childProcessRef?: { current?: ChildProcess }; // caller can stash the spawn handle for cancellation
  abortSignal?: AbortSignal;
}

export interface JobFailure {
  code: ErrorCode;
  message: string;
  rawError?: string;
}

export type EmitFn = (partial: Partial<JobProgress>, force?: boolean) => void;

export interface RunResult {
  status: 'ready' | 'cancelled';
  filePath?: string;
  downloadFilename?: string;
  contentType?: string;
}

/**
 * Run a single download attempt. Resolves on success or cancellation;
 * rejects with `JobFailure` on failure.
 */
export function runDownloadJob(
  ctx: JobRunContext,
  emit: EmitFn,
  signal?: { cancelled: boolean },
  useCachedInfo = true,
): Promise<RunResult> {
  if (ctx.abortSignal?.aborted) return Promise.resolve({ status: 'cancelled' });
  if (ctx.request.format.kind === 'original') return runSourceDownload(ctx, emit);
  return new Promise((resolve, reject) => {
    const { jobId, attempt, request } = ctx;
    const fmt = request.format;

    const safeTitle = sanitizeFilename(request.meta?.title || 'audio');

    // ── Dedicated Spotify Track Downloader (1:1 Audio Matching & ID3 Tagging) ──
    if (isSpotifyUrl(request.url)) {
      (async () => {
        try {
          emit({ stage: 'downloading', percent: 15, speed: 'Searching Track', eta: '3s' }, true);
          const trackInfo = await getSpotifyInfo(request.url);
          const audioFmt = (fmt.audioFormat || 'mp3').toLowerCase();
          const targetExt = audioFmt === 'm4a' ? 'm4a' : audioFmt === 'flac' ? 'flac' : audioFmt === 'wav' ? 'wav' : 'mp3';
          const outFileName = `${sanitizeFilename(trackInfo.artist + ' - ' + trackInfo.title)}.${targetExt}`;
          const outFilePath = path.join(CONFIG.TEMP_DIR, `${jobId}.${targetExt}`);

          emit({ stage: 'processing', percent: 50, speed: 'Embedding ID3 Tags', eta: '2s' }, true);
          await downloadSpotifyTrackAudio({
            trackInfo,
            format: targetExt,
            outputFilePath: outFilePath,
            tempDir: CONFIG.TEMP_DIR,
          });

          emit({ stage: 'finalizing', percent: 98, speed: '', eta: '' }, true);
          return resolve({
            status: 'ready',
            filePath: outFilePath,
            downloadFilename: outFileName,
            contentType: targetExt === 'mp3' ? 'audio/mpeg' : targetExt === 'm4a' ? 'audio/mp4' : targetExt === 'flac' ? 'audio/flac' : 'audio/wav',
          });
        } catch (err: any) {
          return reject({
            code: ErrorCode.INTERNAL,
            message: err.message || 'Spotify audio download failed.',
          });
        }
      })();
      return;
    }

    const isAudioOnly = fmt.kind === 'audio';

    // Determine extension + content type up front so the manifest is correct.
    let ext = 'mp4';
    let contentType = 'video/mp4';
    if (isAudioOnly) {
      const audioFmt = (fmt.audioFormat || 'mp3').toLowerCase();
      ext = audioFmt;
      contentType =
        audioFmt === 'mp3'  ? 'audio/mpeg' :
        audioFmt === 'm4a'  ? 'audio/mp4'  :
        audioFmt === 'flac' ? 'audio/flac' :
        audioFmt === 'wav'  ? 'audio/wav'  :
        audioFmt === 'aac'  ? 'audio/aac'  :
        audioFmt === 'opus' ? 'audio/ogg'  :
        'audio/mpeg';
    } else if (fmt.container === 'webm') {
      ext = 'webm';
      contentType = 'video/webm';
    } else if (fmt.container === 'mkv') {
      ext = 'mkv';
      contentType = 'video/x-matroska';
    }

    const downloadFilename = fmt.filenameTemplate
      ? `${safeTitle}.${ext}`  // yt-dlp -o handles the template
      : `${safeTitle}.${ext}`;

    const outputTemplate = path.join(CONFIG.TEMP_DIR, `${jobId}.%(ext)s`);

    // Pre-flight: check disk space (best-effort, based on extraction size estimate)
    if (request.meta?.duration) {
      const estimatedBytes = estimateSizeBytes(fmt, request.meta.duration);
      if (estimatedBytes > 0 && !storageService.hasSpaceFor(estimatedBytes)) {
        return reject({
          code: ErrorCode.DISK_FULL,
          message: 'Insufficient disk space for this download.',
        } as JobFailure);
      }
    }

    const sourceUrl = request.sanitizedUrl || request.url;
    let infoPath: string | undefined;
    if (useCachedInfo && attempt === 1 && fmt.kind === 'video' && !fmt.subtitles && !fmt.thumbnail && !fmt.trim) {
      const info = getCachedYouTubeDownloadInfo(sourceUrl, fmt.format_id);
      if (info) {
        const cachedPath = path.join(CONFIG.TEMP_DIR, 'metadata-' + jobId + '.json');
        try {
          fs.writeFileSync(cachedPath, info, { flag: 'wx', mode: 0o600 });
          infoPath = cachedPath;
        } catch {}
      }
    }
    const args = buildDownloadArgs(
      { jobId, attempt, url: request.url, sanitizedUrl: sourceUrl, format: fmt, meta: request.meta },
      fmt.filenameTemplate ? path.join(CONFIG.TEMP_DIR, fmt.filenameTemplate) : outputTemplate,
      infoPath,
    );

    emit({ status: 'starting', percent: 0, downloadFilename, contentType, attempt }, true);

    const binary = getYtDlpPath();
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    if (ctx.childProcessRef) ctx.childProcessRef.current = child;
    const abortChild = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        const taskkill = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, (error) => {
          if (error && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      }
    };
    ctx.abortSignal?.addEventListener('abort', abortChild, { once: true });

    let stderrBuffer = '';
    let processError: Error | undefined;
    let totalDurationSec = request.meta?.duration ?? 0;
    let lastEmittedPercent = 0;
    // aria2 separates progress updates with carriage returns.
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on('line', (line) => {
      const cleanLine = line.trim();
      if (!cleanLine) return;

      if (!totalDurationSec) {
        const durationMatch = cleanLine.match(/Duration:\s*([\d:]+)/i);
        if (durationMatch) {
          const parts = durationMatch[1].split(':').map(parseFloat);
          if (parts.length === 3) totalDurationSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
          else if (parts.length === 2) totalDurationSec = parts[0] * 60 + parts[1];
        }
      }

      if (
        cleanLine.includes('[ffmpeg]') ||
        cleanLine.includes('[Merger]') ||
        cleanLine.includes('[VideoConvertor]') ||
        cleanLine.includes('[ExtractAudio]') ||
        cleanLine.includes('[FixupM3u3]') ||
        cleanLine.includes('Post-processing')
      ) {
        emit({ status: 'merging', stage: 'processing', speed: '', eta: '' });
        return;
      }

      const progress = parseFfmpegProgress(cleanLine, totalDurationSec, lastEmittedPercent)
        ?? parseYtDlpOutput(cleanLine);
      if (progress) {
        emit(progress);
        lastEmittedPercent = progress.percent ?? lastEmittedPercent;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.on('close', async (code: number | null) => {
      ctx.abortSignal?.removeEventListener('abort', abortChild);
      if (ctx.childProcessRef) ctx.childProcessRef.current = undefined;
      if (infoPath) await fs.promises.unlink(infoPath).catch(() => {});

      if (signal?.cancelled || ctx.abortSignal?.aborted) {
        const files = await fs.promises.readdir(CONFIG.TEMP_DIR).catch(() => []);
        await Promise.all(files.filter((file) => file.startsWith(jobId + '.')).map((file) =>
          fs.promises.unlink(path.join(CONFIG.TEMP_DIR, file)).catch(() => {})));
        return resolve({ status: 'cancelled' });
      }

      if (processError) {
        return reject({ code: ErrorCode.INTERNAL, message: processError.message, rawError: processError.message } as JobFailure);
      }

      if (code === 0) {
        // Look for the final file. The output template is `${jobId}.%(ext)s`,
        // so we glob for files starting with jobId and exclude .part / fragments.
        let generatedFile: string | undefined;
        try {
          const files = fs.readdirSync(CONFIG.TEMP_DIR);
          generatedFile =
            files.find((f) => f.startsWith(jobId) && !f.endsWith('.part') && !/\.f\d+\./.test(f)) ||
            files.find((f) => f.startsWith(jobId) && !f.endsWith('.part'));
        } catch {}

        if (generatedFile) {
          const filePath = path.join(CONFIG.TEMP_DIR, generatedFile);
          return resolve({ status: 'ready', filePath, downloadFilename, contentType });
        }

        // code 0 but no file — treat as internal error
        return reject({
          code: ErrorCode.INTERNAL,
          message: 'yt-dlp exited successfully but no output file was found.',
          rawError: stderrBuffer,
        } as JobFailure);
      }

      // Signed media URLs can expire. Retry from the original link immediately.
      if (infoPath) return resolve(runDownloadJob(ctx, emit, signal, false));

      // Non-zero exit: classify the error and decide retryability
      const rawError = stderrBuffer.replace(/\x1b\[[0-9;]*m/g, '').trim();
      const errorCode = classifyYtDlpError(rawError);
      const message = friendlyMessage(errorCode, rawError);

      return reject({ code: errorCode, message, rawError } as JobFailure);
    });

    child.on('error', (err: Error) => {
      processError = err;
    });
  });
}

// ── Output parsers ──────────────────────────────────────────────────────────
function parseYtDlpOutput(cleanLine: string): Partial<JobProgress> | null {
  if (cleanLine.startsWith('{') && cleanLine.endsWith('}')) {
    try {
      const data = JSON.parse(cleanLine);
      if (data.status === 'finished') return null; // fragment done — let close handler deal with it

      if (data.status === 'downloading' || data.downloaded_bytes !== undefined) {
        const downloadedBytes = Number(data.downloaded_bytes) || 0;
        const totalBytes = Number(data.total_bytes || data.total_bytes_estimate) || 0;

        let rawPct = 0;
        if (data._percent !== undefined && !isNaN(parseFloat(String(data._percent)))) {
          rawPct = parseFloat(String(data._percent));
        } else if (totalBytes > 0) {
          rawPct = (downloadedBytes / totalBytes) * 100;
        }
        // Scale to 0..74 range, leaving 75..100 for the ffmpeg merge phase
        const percent = Number(Math.min(74, (rawPct / 100) * 75).toFixed(1));

        let speed = '';
        if (data.speed && !isNaN(parseFloat(String(data.speed)))) {
          const bps = parseFloat(String(data.speed));
          speed = bps >= 1024 * 1024
            ? `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
            : `${(bps / 1024).toFixed(0)} KB/s`;
        }

        let eta = '';
        if (data.eta !== undefined && data.eta !== null) {
          const sec = parseInt(String(data.eta), 10);
          if (!isNaN(sec) && sec >= 0) {
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            eta = m > 0 ? `${m}m ${s}s` : `${s}s`;
          }
        }

        let downloadedSize = '';
        let totalSize = '';
        if (totalBytes > 0) {
          const totMb = totalBytes / (1024 * 1024);
          const dlMb = downloadedBytes / (1024 * 1024);
          totalSize = totMb >= 1024 ? `${(totMb / 1024).toFixed(2)} GB` : `${totMb.toFixed(1)} MB`;
          downloadedSize = totMb >= 1024 ? `${(dlMb / 1024).toFixed(2)} GB` : `${dlMb.toFixed(1)} MB`;
        }

        return { status: 'downloading', percent, speed, eta, stage: 'downloading', downloadedSize, totalSize };
      }
    } catch {}
  }

  const ariaProgress = cleanLine.match(/^\[#[\da-f]+\s+(\S+)\/([^\s(]+)\(([\d.]+)%\)\s+CN:\d+\s+DL:([^\s\]]+)(?:\s+ETA:([^\s\]]+))?\]/i);
  if (ariaProgress) {
    const [, downloaded, total, percent, speed, eta] = ariaProgress;
    const formatSize = (size: string) => size.replace(/(\d)([KMGT]?i?B)$/i, '$1 $2');
    return {
      status: 'downloading',
      stage: 'downloading',
      percent: Number(Math.min(74, Number(percent) * 0.75).toFixed(1)),
      downloadedSize: formatSize(downloaded),
      totalSize: formatSize(total),
      speed: speed === '0B' ? '' : formatSize(speed) + '/s',
      eta: eta ?? '',
    };
  }

  const pctMatch = cleanLine.match(/\[download\]\s+([\d\.]+)%/i);
  if (pctMatch) {
    const rawPct = parseFloat(pctMatch[1]);
    return { status: 'downloading', percent: Number(Math.min(74, (rawPct / 100) * 75).toFixed(1)), stage: 'downloading' };
  }

  return null;
}

function parseFfmpegProgress(cleanLine: string, totalDurationSec: number, currentProgress: number): Partial<JobProgress> | null {
  let elapsedSec: number | null = null;
  const timeMatch = cleanLine.match(/(?:out_time|time)=([\d:]+(?:\.\d+)?)/i);

  if (timeMatch) {
    const parts = timeMatch[1].split(':').map(parseFloat);
    if (parts.length === 3) elapsedSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) elapsedSec = parts[0] * 60 + parts[1];
    else if (parts.length === 1) elapsedSec = parts[0];
  }

  if (elapsedSec !== null && elapsedSec >= 0) {
    // Simplified: progress = 75 + clamp(elapsed / totalDuration, 0, 1) * 20  → 75..95
    let ffmpegPct: number;
    if (totalDurationSec > 0) {
      ffmpegPct = Math.min(1, Math.max(0, elapsedSec / totalDurationSec));
    } else {
      // Fallback: +1% per 2 seconds, capped at 95
      ffmpegPct = Math.min(1, Math.max(0, (currentProgress - 75) / 20) + 0.05);
    }
    const percent = Number((75 + ffmpegPct * 20).toFixed(1));
    return { status: 'merging', percent, speed: '', eta: '', stage: 'processing' };
  }

  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function friendlyMessage(code: ErrorCode, rawError: string): string {
  const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
    [ErrorCode.VIDEO_UNAVAILABLE]: 'This video is unavailable, private, or deleted.',
    [ErrorCode.VIDEO_PRIVATE]: 'This video is private or members-only.',
    [ErrorCode.VIDEO_GEO_BLOCKED]: 'This video is geo-restricted in your region.',
    [ErrorCode.VIDEO_AGE_RESTRICTED]: 'This video is age-restricted or requires sign-in.',
    [ErrorCode.VIDEO_COPYRIGHT]: 'This video is restricted due to copyright or removal.',
    [ErrorCode.RATE_LIMITED]: 'The source platform is rate-limiting us. Please retry shortly.',
    [ErrorCode.INTERNAL]: 'An internal error occurred during download.',
    [ErrorCode.EXTRACTION_FAILED]: 'Download failed. Please try again.',
    [ErrorCode.INVALID_URL]: 'The provided URL is invalid.',
    [ErrorCode.MISSING_PARAMETER]: 'A required parameter is missing.',
    [ErrorCode.JOB_NOT_FOUND]: 'Job not found or has expired.',
    [ErrorCode.JOB_EXPIRED]: 'This job has expired.',
    [ErrorCode.QUEUE_FULL]: 'The download queue is full.',
    [ErrorCode.DISK_FULL]: 'Server storage is full.',
    [ErrorCode.DUPLICATE_JOB]: 'A job for this URL and quality is already in progress.',
    [ErrorCode.TOKEN_INVALID]: 'Download token is invalid.',
    [ErrorCode.TOKEN_EXPIRED]: 'Download token has expired.',
    [ErrorCode.API_KEY_INVALID]: 'API key is missing or invalid.',
    [ErrorCode.INVALID_PARAMETER]: 'One or more request parameters are invalid.',
    [ErrorCode.BOT_VERIFICATION_FAILED]: 'Cloudflare Turnstile bot verification failed.',
    [ErrorCode.PAYLOAD_TOO_LARGE]: 'The requested file is too large to process.',
  };
  return DEFAULT_MESSAGES[code] || rawError || 'Download failed.';
}

export function estimateSizeBytes(fmt: DownloadRequest['format'], durationSec: number): number {
  // Rough heuristic so we can reject oversized jobs pre-flight.
  // Real value comes from the extraction result; this is a fallback.
  const sec = Math.max(1, durationSec);
  if (fmt.kind === 'audio') return sec * 320 * 1024 / 8; // 320 kbps
  // Video bitrate by height (rough)
  const heightToMbps: Record<number, number> = {
    360: 0.8, 480: 1.5, 720: 3, 1080: 6, 1440: 12, 2160: 25, 4320: 60,
  };
  const mbps = heightToMbps[fmt.height ?? 1080] ?? 6;
  return sec * mbps * 1024 * 1024 / 8;
}

// Re-exported for the routes that need to set up event sources
export { parseYtDlpOutput, parseFfmpegProgress };
