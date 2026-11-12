import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CONFIG } from '../config';
import { ErrorCode } from '../utils/errors';
import { isPathInsideDir, sanitizeFilename } from '../utils/sanitizer';
import { openEngineProxy } from './engine-proxy';
import { fetchCdnStream, PublicTargetError } from './proxy.service';
import { describeDirectSource, isLiveChannel, resolvePublicDocumentUrl } from './source-discovery';
import { exec, getNMediaPath, getStreamlinkPath, liveRecordClock } from './source-engines';
import { storageService } from './storage.service';
import { getFfmpegPath } from './ytdl.service';
import type { EmitFn, JobRunContext, RunResult } from './job-runner';

class SourceError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(1) + ' KB';
}

export async function runSourceDownload(ctx: JobRunContext, emit: EmitFn): Promise<RunResult> {
  const { request, jobId, abortSignal } = ctx;
  const url = resolvePublicDocumentUrl(request.sanitizedUrl || request.url);
  const limit = CONFIG.DIRECT_DOWNLOAD_MAX_BYTES;
  const timeout = AbortSignal.timeout(CONFIG.DOWNLOAD_TIMEOUT_MS);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  let tmpFile: string | undefined;
  let workdir: string | undefined;
  let completed = false;
  let proxy: Awaited<ReturnType<typeof openEngineProxy>> | undefined;
  let upstream: Awaited<ReturnType<typeof fetchCdnStream>> | undefined;
  try {
    emit({ status: 'starting' }, true);
    const live = isLiveChannel(url);
    if (!live) upstream = await fetchCdnStream(url, { 'Accept-Encoding': 'identity' }, 6, { signal });
    const source = upstream && upstream.statusCode >= 200 && upstream.statusCode < 300
      ? describeDirectSource(upstream.finalUrl, upstream.headers) : null;
    if (!live && !source) {
      throw new SourceError(ErrorCode.VIDEO_UNAVAILABLE, 'This link no longer returns a supported downloadable file or stream.');
    }
    if (source?.kind === 'file' && upstream) {
      if (source.size && source.size > limit) throw new SourceError(ErrorCode.PAYLOAD_TOO_LARGE, 'This file exceeds the download size limit.');
      if (!storageService.hasSpaceFor(source.size || 0)) throw new SourceError(ErrorCode.DISK_FULL, 'The download storage volume is low on free space.');
      tmpFile = path.join(CONFIG.TEMP_DIR, jobId + '.' + source.extension);
      let written = 0;
      let lastUpdate = 0;
      const started = Date.now();
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          written += chunk.length;
          if (written > limit) return done(new SourceError(ErrorCode.PAYLOAD_TOO_LARGE, 'This file exceeds the download size limit.'));
          const now = Date.now();
          if (now - lastUpdate >= 250) {
            lastUpdate = now;
            const elapsed = Math.max((now - started) / 1000, 0.25);
            emit({ status: 'downloading', stage: 'downloading', downloadedSize: sizeLabel(written),
              totalSize: source.size ? sizeLabel(source.size) : '',
              speed: sizeLabel(written / elapsed) + '/s',
              percent: source.size ? Math.min(98, written / source.size * 98) : 0 }, true);
          }
          done(null, chunk);
        },
      });
      await pipeline(upstream.stream, meter, fs.createWriteStream(tmpFile, { flags: 'wx' }), { signal });
      if (!written || (source.size && written !== source.size)) throw new Error('Incomplete file response.');
      const stored = await store(jobId + '.' + source.extension, tmpFile);
      completed = true;
      return { status: 'ready', filePath: stored, downloadFilename: source.filename, contentType: source.contentType };
    }

    const manifestUrl = upstream?.finalUrl;
    upstream?.stream.destroy();
    if (!storageService.hasSpaceFor(0)) throw new SourceError(ErrorCode.DISK_FULL, 'The download storage volume is low on free space.');
    const nmedia = getNMediaPath();
    const streamlink = getStreamlinkPath();
    if (live ? !streamlink : !nmedia && !streamlink) {
      throw new SourceError(ErrorCode.VIDEO_UNAVAILABLE, 'This server does not have a downloader for this stream.');
    }
    const streamSignal = live ? AbortSignal.any([signal, AbortSignal.timeout((CONFIG.LIVE_RECORD_SECONDS + 45) * 1000)]) : signal;
    proxy = await openEngineProxy(streamSignal, limit);
    workdir = await fs.promises.mkdtemp(path.join(CONFIG.TEMP_DIR, 'stream-'));
    const ffmpeg = getFfmpegPath();
    let recordedFile: string | undefined;
    emit({ status: 'downloading', stage: 'downloading' }, true);
    if (manifestUrl && nmedia) {
      try {
        await exec(nmedia, [manifestUrl, '--auto-select', '--thread-count', '6', '--save-dir', workdir,
          '--tmp-dir', workdir, '--save-name', 'capture', '--no-log', '--no-date-info', '--no-ansi-color',
          '--custom-proxy', proxy.url, '--ffmpeg-binary-path', ffmpeg, '--live-record-limit', liveRecordClock(),
          '--live-real-time-merge', '--live-keep-segments', 'false', '-M', 'format=mp4:keep=false'],
        { cwd: workdir, signal: proxy.signal, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
        const entries = await fs.promises.readdir(workdir);
        const captured = ['capture.mp4', 'capture.ts', 'capture.m4a', 'capture.aac'].find((file) => entries.includes(file));
        if (captured) recordedFile = path.join(workdir, captured);
      } catch (error) {
        if (proxy.signal.aborted || !streamlink) throw error;
      }
    }
    if (!recordedFile && streamlink) {
      const input = live ? url : source?.kind + '://' + manifestUrl;
      recordedFile = path.join(workdir, 'streamlink.ts');
      await exec(streamlink, ['--config', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '--http-proxy', proxy.url, '--http-timeout', '10', '--ffmpeg-ffmpeg', ffmpeg,
        '--stream-segment-threads', '4', '--progress', 'no',
        ...(live ? ['--stream-segmented-duration', String(CONFIG.LIVE_RECORD_SECONDS)] : []),
        '--output', recordedFile, '--', input, 'best'],
      { cwd: workdir, signal: proxy.signal, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    }
    if (!recordedFile || !(await fs.promises.stat(recordedFile)).size) throw new Error('Empty stream recording.');
    emit({ status: 'merging', stage: 'processing', percent: 95 }, true);
    tmpFile = path.join(CONFIG.TEMP_DIR, jobId + '.mp4');
    await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe',
      '-i', recordedFile, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', tmpFile],
    { cwd: workdir, signal, maxBuffer: 512 * 1024, windowsHide: true });
    const stored = await store(jobId + '.mp4', tmpFile);
    completed = true;
    return { status: 'ready', filePath: stored, contentType: 'video/mp4',
      downloadFilename: source?.filename || sanitizeFilename(new URL(url).pathname.split('/')[1], 'recording') + '.mp4' };
  } catch (error) {
    if (abortSignal?.aborted) return { status: 'cancelled' };
    if (error instanceof SourceError) throw { code: error.code, message: error.message };
    if (error instanceof PublicTargetError) throw { code: ErrorCode.INVALID_URL, message: error.message };
    if (proxy?.signal.aborted && !signal.aborted) {
      throw { code: ErrorCode.VIDEO_UNAVAILABLE, message: 'The stream reached its recording or transfer limit.' };
    }
    throw { code: ErrorCode.EXTRACTION_FAILED, message: 'Could not download this public file or stream. The source may be unavailable.' };
  } finally {
    upstream?.stream.destroy();
    proxy?.close();
    if (tmpFile && !completed) await fs.promises.unlink(tmpFile).catch(() => {});
    if (workdir && workdir !== CONFIG.TEMP_DIR && isPathInsideDir(CONFIG.TEMP_DIR, workdir)) {
      await fs.promises.rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function store(key: string, tempPath: string): Promise<string> {
  const stored = await storageService.saveFile(key, tempPath);
  if (stored !== tempPath) await fs.promises.unlink(tempPath).catch(() => {});
  return stored;
}
