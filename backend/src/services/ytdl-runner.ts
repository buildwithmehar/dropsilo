import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { CONFIG } from '../config';
import { LruTtlCache } from './cache.service';
import { classifyYtDlpError } from '../utils/errors';
import { pickProxyForJob } from '../utils/requestId';
import {
  AudioOption,
  RealQuality,
  VideoExtractionResult,
  getFfmpegPath,
  getYtDlpPath,
  getAria2cPath,
} from './ytdl.service';
import { isSpotifyUrl, getSpotifyInfo, formatSpotifyExtraction } from './spotify.service';

const execFileAsync = promisify(execFile);

/**
 * The actual yt-dlp runner. Extracted into its own module so that both
 * queue adapters (In-Memory and Redis) can call it without duplicating logic.
 *
 * Two entry points:
 *   - extractMetadata(url) → VideoExtractionResult   (one-shot, cached)
 *   - runDownloadJob(job, callbacks) → ChildProcess  (streaming, long-lived)
 *
 * Every yt-dlp invocation here:
 *   - picks a proxy per attempt (round-robin via utils/requestId.ts)
 *   - attaches cookie file if COOKIES_FILE_PATH is set
 *   - attaches ffmpeg location if FFMPEG_PATH is set
 *   - uses a stable user-agent + Accept-Language header
 *   - retries the *whole* extraction once with an alternative YouTube player
 *     client if the first attempt hit a 429 / Sign-in / bot-detection wall
 */

const extractionCache = new LruTtlCache<VideoExtractionResult>(CONFIG.CACHE_TTL_MS, CONFIG.CACHE_MAX_ENTRIES);
const youtubeDownloadInfo = new LruTtlCache<{ json: string; formats: Set<string> }>(120_000, 32);

export function getCachedYouTubeDownloadInfo(url: string, formatId?: string): string | undefined {
  if (!formatId || !/^\d+(?:\+\d+)?$/.test(formatId)) return;
  const cached = youtubeDownloadInfo.get(url);
  if (cached && formatId.split('+').every((id) => cached.formats.has(id))) return cached.json;
}

/** Build the common yt-dlp args shared by extract + download paths. */
function buildCommonArgs(opts: { url: string; proxyUrl?: string; resolvedIp?: string }): string[] {
  const isYouTube = opts.url.includes('youtube.com') || opts.url.includes('youtu.be');

  const args: string[] = [
    '--no-config',
    '--no-exec',
    '--no-playlist',
    '--no-check-certificate',
    '--geo-bypass',
    '--extractor-args', 'youtube:player_client=default,mweb,android',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    '--add-headers', 'Accept-Language:en-US,en;q=0.9',
    '--socket-timeout', '30',
  ];

  if (opts.resolvedIp) {
    args.push('--source-address', opts.resolvedIp);
    if (!opts.resolvedIp.includes(':')) {
      args.push('--force-ipv4');
    }
  }

  const ffmpegBinary = getFfmpegPath();
  if (fs.existsSync(ffmpegBinary)) {
    args.push('--ffmpeg-location', path.dirname(ffmpegBinary));
  }

  if (CONFIG.COOKIES_FILE_PATH && fs.existsSync(CONFIG.COOKIES_FILE_PATH)) {
    args.push('--cookies', CONFIG.COOKIES_FILE_PATH);
  }

  if (opts.proxyUrl) {
    args.push('--proxy', opts.proxyUrl);
  }

  return args;
}

/** Stream stdout incrementally using spawn to prevent maxBuffer memory spikes on large metadata JSONs. */
function spawnStreamJson(binary: string, args: string[], timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const cp = spawn(binary, args);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      try { cp.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    timer.unref?.();

    cp.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    cp.stderr.on('data', (chunk: Buffer) => {
      errChunks.push(chunk);
    });

    cp.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    cp.on('close', (code) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        return reject(new Error(`yt-dlp process timed out after ${timeoutMs}ms`));
      }
      const stdoutText = Buffer.concat(chunks).toString('utf-8');
      const stderrText = Buffer.concat(errChunks).toString('utf-8');

      if (code !== 0 && !stdoutText.trim()) {
        const errObj: any = new Error(stderrText || `yt-dlp process exited with code ${code}`);
        errObj.stderr = stderrText;
        errObj.code = code;
        return reject(errObj);
      }

      try {
        const json = JSON.parse(stdoutText);
        resolve(json);
      } catch (parseErr: any) {
        const errObj: any = new Error(`Failed to parse yt-dlp JSON output: ${parseErr.message}`);
        errObj.stderr = stderrText;
        reject(errObj);
      }
    });
  });
}

/**
 * Run `yt-dlp --dump-json` and parse the result.
 *
 * Retries once with the `mweb,ios` player-client combo if the first
 * attempt hit a bot-detection / Sign-in / 429 wall.
 */
export async function dumpVideoJson(url: string, opts: { proxyUrl?: string; resolvedIp?: string } = {}): Promise<any> {
  const binary = getYtDlpPath();
  const args = [...buildCommonArgs({ url, proxyUrl: opts.proxyUrl, resolvedIp: opts.resolvedIp }), '--dump-json', '--', url];

  try {
    return await spawnStreamJson(binary, args, CONFIG.EXTRACTION_TIMEOUT_MS);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`yt-dlp executable not found at "${binary}". Place yt-dlp binary inside "backend/bin/".`);
    }

    const stderrText = (err?.stderr || err?.message || '') as string;

    // Retry with alternative YouTube player clients on bot detection
    if (stderrText.includes('Sign in') ||
        stderrText.includes('bot') ||
        stderrText.includes('blocked') ||
        stderrText.includes('403') ||
        stderrText.includes('429')) {
      const retryArgs = [
        ...buildCommonArgs({ url, proxyUrl: opts.proxyUrl }),
        '--extractor-args', 'youtube:player_client=ios,web',
        '--dump-json',
        '--',
        url
      ];
      try {
        return await spawnStreamJson(binary, retryArgs, CONFIG.EXTRACTION_TIMEOUT_MS);
      } catch (retryErr: any) {
        const finalStderr = (retryErr?.stderr || retryErr?.message || '') as string;
        throw new Error(finalStderr || 'yt-dlp metadata extraction failed.');
      }
    }

    throw new Error(stderrText || 'yt-dlp metadata extraction failed.');
  }
}

/** Cached, single-flight wrapper around dumpVideoJson + the format parser. */
export async function extractMediaInfo(videoUrl: string): Promise<VideoExtractionResult> {
  // 1. Check for Spotify Track / Album / Playlist
  if (isSpotifyUrl(videoUrl)) {
    const spotifyInfo = await getSpotifyInfo(videoUrl);
    return formatSpotifyExtraction(spotifyInfo, videoUrl);
  }

  return extractionCache.getOrExecute(videoUrl, async () => {
    // Try without proxy first — most extractions work without one and avoid
    // burning proxy egress.
    const info = await dumpVideoJson(videoUrl).catch(async (err) => {
      // On rate-limit / geo / 429, retry once with a proxy if available.
      const msg = (err?.message || '').toLowerCase();
      const shouldRetryWithProxy =
        CONFIG.PROXY_URLS.length > 0 &&
        (msg.includes('429') || msg.includes('rate limit') || msg.includes('geo') || msg.includes('region'));
      if (!shouldRetryWithProxy) throw err;
      return dumpVideoJson(videoUrl, { proxyUrl: CONFIG.PROXY_URLS[0] });
    });

    const result = parseExtractionResult(info, videoUrl);
    if (info.extractor_key === 'Youtube' && !info.is_live && !CONFIG.COOKIES_FILE_PATH && !CONFIG.PROXY_URLS.length) {
      const formats = new Set<string>();
      for (const format of info.formats ?? []) {
        if (format.protocol !== 'https' || typeof format.format_id !== 'string') continue;
        try {
          const stream = new URL(format.url);
          if (stream.protocol === 'https:' && stream.hostname.endsWith('.googlevideo.com')) formats.add(format.format_id);
        } catch {}
      }
      if (formats.size > 0) {
        const json = JSON.stringify(info);
        if (Buffer.byteLength(json) <= 512 * 1024) youtubeDownloadInfo.set(videoUrl, { json, formats });
      }
    }
    return result;
  });
}

/**
 * Build the yt-dlp command-line for a download job.
 */
export function buildDownloadArgs(
  job: {
    jobId: string;
    attempt: number;
    url: string;
    sanitizedUrl: string;
    format: import('./queue.types').DownloadRequest['format'];
    meta?: { title?: string; duration?: number };
  },
  outputTemplate: string,
  infoPath?: string
): string[] {
  const args = buildCommonArgs({
    url: job.sanitizedUrl,
    proxyUrl: pickProxyForJob(job.jobId, job.attempt - 1),
  });

  // Use aria2 for supported HTTP transfers. Let yt-dlp handle HLS/DASH fragments.
  const aria2Path = getAria2cPath();
  if (aria2Path && fs.existsSync(aria2Path)) {
    args.push(
      '--downloader', aria2Path,
      '--downloader', 'dash,m3u8:native',
      '--downloader-args', `aria2c:-s ${CONFIG.ARIA2_CONNECTIONS} -x ${CONFIG.ARIA2_CONNECTIONS} -k 1M`
    );
  }

  args.push(
    '--concurrent-fragments', '4',
    '--buffer-size', '8M',
    '--retries', '3',
    '--newline',
    '--progress-template', '%(progress)j',
    '-o', outputTemplate,
  );

  const f = job.format;

  if (f.kind === 'audio') {
    const audioFmt = (f.audioFormat || 'mp3').toLowerCase();
    args.push(
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', audioFmt,
      '--audio-quality', '0',
      '--embed-thumbnail',
      '--add-metadata'
    );
  } else {
    if (f.format_id && f.format_id.length > 0) {
      if (f.format_id === 'best' || f.format_id === 'fallback_best') {
        args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', f.container || 'mp4');
      } else if (f.format_id.includes('+')) {
        args.push('-f', f.format_id, '--merge-output-format', f.container || 'mp4');
      } else {
        args.push('-f', `${f.format_id}/best`, '--merge-output-format', f.container || 'mp4');
      }
    } else {
      const height = f.height ?? 720;
      const fps = f.fps ?? 60;
      const formatSpec = `bestvideo[height<=${height}][fps<=${fps}]+bestaudio/bestvideo[height<=${height}]+bestaudio/best/best`;
      args.push('-f', formatSpec, '--merge-output-format', f.container || 'mp4');
    }
  }

  // ── Subtitle / Thumbnail / Section options ────────────────────────────────
  if (f.subtitles) {
    args.push('--write-subs', '--write-auto-subs', '--embed-subs');
    if (f.subtitleLangs && Array.isArray(f.subtitleLangs) && f.subtitleLangs.length > 0) {
      const langRegex = /^[a-z]{2}(-[A-Z]{2})?$/;
      const validLangs = f.subtitleLangs.filter((l) => typeof l === 'string' && langRegex.test(l.trim()));
      if (validLangs.length > 0) {
        args.push('--sub-langs', validLangs.join(','));
      } else {
        args.push('--sub-langs', 'all');
      }
    } else {
      args.push('--sub-langs', 'all');
    }
  }
  if (f.thumbnail) {
    args.push('--write-thumbnail', '--embed-thumbnail');
  }
  if (f.trim) {
    const timePattern = /^(\d{1,2}:\d{2}(:\d{2})?(\.\d+)?|\d+(\.\d+)?)$/;
    if (f.trim.start && !timePattern.test(f.trim.start)) {
      throw new Error(`Invalid trim.start parameter: "${f.trim.start}"`);
    }
    if (f.trim.end && !timePattern.test(f.trim.end)) {
      throw new Error(`Invalid trim.end parameter: "${f.trim.end}"`);
    }
    const start = f.trim.start || '0';
    const end = f.trim.end || '';
    args.push('--download-sections', `*${start}-${end}`);
    args.push('--force-keyframes-at-cuts');
  }
  if (f.filenameTemplate) {
    const templateMap: Record<string, string> = {
      title: '%(title)s.%(ext)s',
      uploader_title: '%(uploader)s - %(title)s.%(ext)s',
      artist_title: '%(artist,uploader)s - %(title)s.%(ext)s',
      date_title: '%(upload_date)s - %(title)s.%(ext)s',
    };
    const mapped = templateMap[f.filenameTemplate];
    if (!mapped) {
      const templatePattern = /^(?![-\s])[a-zA-Z0-9 _\-\.]{1,100}$/;
      if (!templatePattern.test(f.filenameTemplate)) {
        throw new Error(`Invalid filenameTemplate parameter: "${f.filenameTemplate}"`);
      }
    }
  }

  // Chapter embedding costs nothing and is nice to have.
  args.push('--embed-chapters', '--embed-metadata');

  if (infoPath) args.push('--load-info-json', infoPath);
  else args.push('--', job.sanitizedUrl);

  return args;
}

/**
 * Parse yt-dlp's `--dump-json` output into the structured VideoExtractionResult
 * shape the frontend expects. Lifted almost verbatim from the original
 * ytdl.service.ts — the format-grouping logic was already correct.
 */
function parseExtractionResult(info: any, videoUrl: string): VideoExtractionResult {
  // (Re-exported from ytdl.service.ts to keep this file self-contained.)
  return parseExtractionResultImpl(info, videoUrl);
}

// ── Parser implementation ─────────────────────────────────────────────────────
// Kept as a separate function so it can be unit-tested without spinning up yt-dlp.
function parseExtractionResultImpl(info: any, videoUrl: string): VideoExtractionResult {
  const title = info.title ?? 'Untitled Video';
  const thumbnail =
    info.thumbnail ??
    (info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : '');
  const duration = info.duration ?? 0;
  const formats: any[] = info.formats || [];

  const audioFormats = formats.filter(
    (f) =>
      (!f.vcodec || f.vcodec === 'none') &&
      f.acodec &&
      f.acodec !== 'none' &&
      f.url &&
      (!f.protocol || (!f.protocol.includes('m3u8') && !f.protocol.includes('m3u8_native')))
  );
  audioFormats.sort((a, b) => (b.tbr || b.abr || 0) - (a.tbr || a.abr || 0));

  const bestAudio = audioFormats[0] || formats.find((f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');
  const audioSizeBytes = getFormatSizeBytes(bestAudio, duration);
  const audioBitrateKbps = bestAudio ? Math.round(bestAudio.abr || bestAudio.tbr || 128) : 128;

  const videoFormats = formats.filter((f) => {
    const hasVideoCodec = !f.vcodec || f.vcodec !== 'none';
    const hasDimension = (f.height && f.height > 0) || (f.width && f.width > 0) || info.height;
    return hasVideoCodec && hasDimension;
  });

  const formatGroupMap = new Map<string, any[]>();
  for (const f of videoFormats) {
    const h = f.height || info.height || 720;
    const fps = f.fps && f.fps > 30 ? Math.round(f.fps) : f.fps ? Math.round(f.fps) : 30;
    const key = `${h}_${fps}`;
    if (!formatGroupMap.has(key)) formatGroupMap.set(key, []);
    formatGroupMap.get(key)!.push(f);
  }

  const sortedKeys = Array.from(formatGroupMap.keys()).sort((a, b) => {
    const [hA, fpsA] = a.split('_').map(Number);
    const [hB, fpsB] = b.split('_').map(Number);
    if (hB !== hA) return hB - hA;
    return fpsB - fpsA;
  });

  const qualities: RealQuality[] = [];

  for (const key of sortedKeys) {
    const fmts = formatGroupMap.get(key)!;
    const [h, fps] = key.split('_').map(Number);
    const isHdr = fmts.some((f) => f.dynamic_range && f.dynamic_range.toLowerCase().includes('hdr'));

    const { label, note } = getQualityLabel(h, fps, isHdr);

    const progressive = fmts.find(
      (f) =>
        f.url &&
        f.vcodec && f.vcodec !== 'none' &&
        f.acodec && f.acodec !== 'none' &&
        (!f.protocol || (!f.protocol.includes('m3u8') && !f.protocol.includes('m3u8_native')))
    );

    if (progressive) {
      const size = getFormatSizeBytes(progressive, duration);
      qualities.push({
        id: `progressive_${h}p_${fps}fps`,
        height: h, fps, isHdr,
        vcodec: progressive.vcodec, acodec: progressive.acodec,
        label, type: 'standard', streamType: 'progressive',
        requiresMerge: false, canDirectDownload: true,
        mergeReason: 'Standard quality video & audio stream. Fast direct download.',
        ext: progressive.ext || 'mp4', url: progressive.url,
        note, size, formattedSize: formatBytes(size),
        format_id: progressive.format_id,
      });
    } else {
      const httpDashFmts = fmts.filter((f) => !f.protocol || !f.protocol.includes('m3u8'));
      const candidateFmts = httpDashFmts.length > 0 ? httpDashFmts : fmts;
      candidateFmts.sort((a, b) => getFormatSizeBytes(b, duration) - getFormatSizeBytes(a, duration));

      const bestVideoFmt = candidateFmts.find((f) => f.ext === 'mp4') || candidateFmts[0];
      const videoSize = getFormatSizeBytes(bestVideoFmt, duration);
      const totalSize = videoSize > 0 ? videoSize + audioSizeBytes : 0;

      const combinedFormatId = bestAudio
        ? `${bestVideoFmt.format_id}+${bestAudio.format_id}`
        : `${bestVideoFmt.format_id}+bestaudio/bestvideo[height<=${h}]+bestaudio/best`;

      qualities.push({
        id: `dash_${h}p_${fps}fps_${isHdr ? 'hdr' : 'sdr'}_${bestVideoFmt.format_id}`,
        height: h, fps, isHdr,
        vcodec: bestVideoFmt.vcodec, acodec: bestAudio?.acodec || 'aac',
        label, type: 'dash', streamType: 'dash',
        requiresMerge: true, canDirectDownload: false,
        mergeReason: `High quality video (${label}) & audio stream. Merged seamlessly with FFmpeg.`,
        ext: 'mp4', video_url: bestVideoFmt.url, audio_url: bestAudio?.url,
        note, size: totalSize, formattedSize: formatBytes(totalSize),
        format_id: combinedFormatId,
      });
    }
  }

  const audioQualities: AudioOption[] = [
    { format: 'mp3',  label: 'MP3 Audio (320 kbps)',  bitrate: '320 kbps',  note: 'Highest Audio Quality (VBR 0)',
      size: audioSizeBytes > 0 ? Math.round(audioSizeBytes * 1.05) : undefined,
      formattedSize: audioSizeBytes > 0 ? formatBytes(Math.round(audioSizeBytes * 1.05)) : undefined },
    { format: 'm4a',  label: 'M4A / AAC (Original)',  bitrate: `${audioBitrateKbps} kbps`, note: 'Direct Original Stream (Zero Quality Loss)',
      size: audioSizeBytes > 0 ? audioSizeBytes : undefined,
      formattedSize: audioSizeBytes > 0 ? formatBytes(audioSizeBytes) : undefined },
    { format: 'flac', label: 'FLAC Lossless Audio',  bitrate: 'Lossless',   note: 'Studio Quality Uncompressed',
      size: audioSizeBytes > 0 ? Math.round(audioSizeBytes * 2.2) : undefined,
      formattedSize: audioSizeBytes > 0 ? formatBytes(Math.round(audioSizeBytes * 2.2)) : undefined },
    { format: 'wav',  label: 'WAV Audio',              bitrate: '1411 kbps', note: 'Uncompressed PCM Audio',
      size: audioSizeBytes > 0 ? Math.round(audioSizeBytes * 3.8) : undefined,
      formattedSize: audioSizeBytes > 0 ? formatBytes(Math.round(audioSizeBytes * 3.8)) : undefined },
  ];

  const extractorKey = (info.extractor_key || info.extractor || '').toLowerCase();
  let platform = 'Universal';
  if (extractorKey.includes('youtube')) platform = 'YouTube';
  else if (extractorKey.includes('spotify')) platform = 'Spotify';
  else if (extractorKey.includes('soundcloud')) platform = 'SoundCloud';
  else if (extractorKey.includes('pinterest')) platform = 'Pinterest';
  else if (extractorKey.includes('instagram')) platform = 'Instagram';
  else if (extractorKey.includes('tiktok')) platform = 'TikTok';
  else if (extractorKey.includes('twitter') || extractorKey.includes('x')) platform = 'Twitter / X';
  else if (extractorKey.includes('facebook')) platform = 'Facebook';
  else if (extractorKey.includes('reddit')) platform = 'Reddit';
  else if (extractorKey.includes('twitch')) platform = 'Twitch';

  if (qualities.length === 0) {
    qualities.push({
      id: 'fallback_best', height: 1080, fps: 30,
      label: 'Best Available Quality', type: 'standard', streamType: 'progressive',
      requiresMerge: false, canDirectDownload: true,
      ext: info.ext || 'mp4', url: info.url || videoUrl,
      note: 'Best Quality', format_id: 'best',
    });
  }

  return { title, thumbnail, duration, qualities, audioQualities, platform, extractor: info.extractor, url: videoUrl };
}

// ── Small helpers (mirrored from the original ytdl.service.ts) ────────────────
function getFormatSizeBytes(fmt: any, durationSec: number): number {
  if (!fmt) return 0;
  if (fmt.filesize && typeof fmt.filesize === 'number' && fmt.filesize > 0) return fmt.filesize;
  if (fmt.filesize_approx && typeof fmt.filesize_approx === 'number' && fmt.filesize_approx > 0) return fmt.filesize_approx;
  const tbr = fmt.tbr || (fmt.vbr || 0) + (fmt.abr || 0);
  if (tbr && tbr > 0 && durationSec > 0) return Math.round(((tbr * 1000) / 8) * durationSec);
  return 0;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function getQualityLabel(height: number, fps = 30, isHdr = false): { label: string; note: string } {
  const fpsText = fps > 30 ? `${fps}` : '';
  const hdrText = isHdr ? ' HDR' : '';
  if (height >= 4320) return { label: `8K${fpsText}${hdrText}`, note: '8K Ultra HD' };
  if (height >= 2160) return { label: `4K${fpsText}${hdrText}`, note: '4K Ultra HD' };
  if (height >= 1440) return { label: `2K${fpsText}${hdrText}`, note: '2K QHD' };
  if (height >= 1080) return { label: `1080p${fpsText}${hdrText}`, note: fps > 30 ? 'Full HD 60FPS' : 'Full HD' };
  if (height >= 720)  return { label: `720p${fpsText}${hdrText}`,  note: fps > 30 ? 'HD 60FPS' : 'HD' };
  if (height >= 480)  return { label: `480p`, note: 'Standard Def' };
  if (height >= 360)  return { label: `360p`, note: 'Fast Download' };
  return { label: `${height}p`, note: 'Low' };
}

export interface PlaylistEntry {
  id: string;
  title: string;
  url: string;
  duration?: number;
  thumbnail?: string;
}

export interface PlaylistExtractionResult {
  playlistTitle: string;
  totalEntries: number;
  entries: PlaylistEntry[];
}

export async function expandPlaylistUrl(playlistUrl: string, opts: { proxyUrl?: string; timeoutMs?: number } = {}): Promise<PlaylistExtractionResult> {
  const binary = getYtDlpPath();
  const args = [
    '--no-exec',
    '--flat-playlist',
    '--dump-single-json',
    '--no-check-certificate',
    '--geo-bypass',
  ];

  if (opts.proxyUrl) {
    args.push('--proxy', opts.proxyUrl);
  }

  args.push('--', playlistUrl);

  const playlistTimeout = opts.timeoutMs || CONFIG.EXTRACTION_TIMEOUT_MS * 3; // 120s dynamic timeout for large playlists
  const json = await spawnStreamJson(binary, args, playlistTimeout);
  const playlistTitle = json.title || json.playlist_title || 'Playlist';
  const rawEntries: any[] = json.entries || [];

  const entries: PlaylistEntry[] = rawEntries.map((e, idx) => {
    const id = e.id || e.url || `entry_${idx}`;
    let url = e.url || e.webpage_url;
    if (url && !url.startsWith('http')) {
      url = `https://www.youtube.com/watch?v=${url}`;
    }
    return {
      id,
      title: e.title || `Video ${idx + 1}`,
      url: url || playlistUrl,
      duration: e.duration,
      thumbnail: e.thumbnail || (e.thumbnails && e.thumbnails.length > 0 ? e.thumbnails[e.thumbnails.length - 1].url : ''),
    };
  });

  return {
    playlistTitle,
    totalEntries: entries.length,
    entries,
  };
}

// Re-exported for routes that still import them from the old module path.
export { classifyYtDlpError };
