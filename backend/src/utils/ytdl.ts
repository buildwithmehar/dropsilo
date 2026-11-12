import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);

export interface AudioOption {
  format: 'mp3' | 'm4a' | 'flac' | 'wav' | 'aac' | 'opus';
  label: string;
  bitrate: string;
  note: string;
  size?: number;
  formattedSize?: string;
}

export interface RealQuality {
  id: string;
  height: number;
  fps?: number;
  isHdr?: boolean;
  vcodec?: string;
  acodec?: string;
  label: string;
  type: 'standard' | 'dash';
  streamType: 'progressive' | 'dash';
  requiresMerge: boolean;
  canDirectDownload: boolean;
  mergeReason?: string;
  ext: string;
  url?: string;
  video_url?: string;
  audio_url?: string;
  note?: string;
  size?: number;
  formattedSize?: string;
  format_id: string;
}

export interface VideoExtractionResult {
  title: string;
  thumbnail: string;
  duration: number;
  qualities: RealQuality[];
  audioQualities: AudioOption[];
  platform?: string;
  extractor?: string;
  url?: string;
}

// In-Memory TTL Cache (30 Minutes)
interface CacheEntry {
  data: VideoExtractionResult;
  expiry: number;
}
const cacheMap = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function getCachedResult(url: string): VideoExtractionResult | null {
  const entry = cacheMap.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    cacheMap.delete(url);
    return null;
  }
  return entry.data;
}

function setCachedResult(url: string, data: VideoExtractionResult) {
  if (cacheMap.size > 100) {
    const now = Date.now();
    for (const [k, v] of cacheMap.entries()) {
      if (now > v.expiry) cacheMap.delete(k);
    }
  }
  cacheMap.set(url, { data, expiry: Date.now() + CACHE_TTL_MS });
}

function getFormatSizeBytes(fmt: any, durationSec: number): number {
  if (!fmt) return 0;
  if (fmt.filesize && typeof fmt.filesize === 'number' && fmt.filesize > 0) {
    return fmt.filesize;
  }
  if (fmt.filesize_approx && typeof fmt.filesize_approx === 'number' && fmt.filesize_approx > 0) {
    return fmt.filesize_approx;
  }
  const tbr = fmt.tbr || ((fmt.vbr || 0) + (fmt.abr || 0));
  if (tbr && tbr > 0 && durationSec > 0) {
    return Math.round((tbr * 1000 / 8) * durationSec);
  }
  return 0;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

export function getFfmpegPath(): string {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const localBinPath = path.resolve(process.cwd(), 'bin', binaryName);
  if (fs.existsSync(localBinPath)) return localBinPath;
  return binaryName;
}

export function getYtDlpPath(): string {
  if (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH)) {
    return process.env.YTDLP_PATH;
  }
  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const localBinPath = path.resolve(process.cwd(), 'bin', binaryName);
  if (fs.existsSync(localBinPath)) return localBinPath;
  return binaryName;
}

async function dumpVideoJson(url: string, retrySsl = false): Promise<any> {
  const binary = getYtDlpPath();
  const ffmpegBinary = getFfmpegPath();

  const args = [
    '--dump-json',
    '--no-playlist',
    '--js-runtimes', 'node',
    '--geo-bypass',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    '--socket-timeout', '10',
  ];

  if (fs.existsSync(ffmpegBinary)) {
    args.push('--ffmpeg-location', path.dirname(ffmpegBinary));
  }

  if (retrySsl) {
    args.push('--no-check-certificate');
  }

  // Prefix positional URL argument with '--' to prevent flag injection
  args.push('--', url);

  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: 30000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `yt-dlp executable not found at "${binary}". Please place your yt-dlp.exe inside the "backend/bin/" folder.`
      );
    }

    const stderrText = err?.stderr || err?.message || '';
    if (!retrySsl && (stderrText.includes('CERTIFICATE_VERIFY_FAILED') || stderrText.includes('certificate validation failed'))) {
      return dumpVideoJson(url, true);
    }

    const msg = stderrText || 'yt-dlp extraction failed';
    throw new Error(msg);
  }
}

function getQualityLabel(height: number, fps = 30, isHdr = false): { label: string; note: string } {
  const fpsText = fps > 30 ? `${fps}` : '';
  const hdrText = isHdr ? ' HDR' : '';

  if (height >= 4320) return { label: `8K${fpsText}${hdrText}`, note: '8K Ultra HD' };
  if (height >= 2160) return { label: `4K${fpsText}${hdrText}`, note: '4K Ultra HD' };
  if (height >= 1440) return { label: `2K${fpsText}${hdrText}`, note: '2K QHD' };
  if (height >= 1080) return { label: `1080p${fpsText}${hdrText}`, note: fps > 30 ? 'Full HD 60FPS' : 'Full HD' };
  if (height >= 720) return { label: `720p${fpsText}${hdrText}`, note: fps > 30 ? 'HD 60FPS' : 'HD' };
  if (height >= 480) return { label: `480p`, note: 'Standard Def' };
  if (height >= 360) return { label: `360p`, note: 'Fast Download' };
  return { label: `${height}p`, note: 'Low' };
}

export async function extractMediaInfo(videoUrl: string): Promise<VideoExtractionResult> {
  const cached = getCachedResult(videoUrl);
  if (cached) return cached;

  const info = await dumpVideoJson(videoUrl);

  const title = info.title ?? 'Untitled Video';
  const thumbnail = info.thumbnail ?? (info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : '');
  const duration = info.duration ?? 0;

  const formats: any[] = info.formats || [];

  // Strictly filter TRUE audio-only streams (vcodec === 'none' AND acodec !== 'none')
  const audioFormats = formats.filter(
    (f) =>
      (!f.vcodec || f.vcodec === 'none') &&
      f.acodec &&
      f.acodec !== 'none' &&
      f.url &&
      (!f.protocol || (!f.protocol.includes('m3u8') && !f.protocol.includes('m3u8_native')))
  );
  audioFormats.sort((a, b) => (b.tbr || b.abr || 0) - (a.tbr || a.abr || 0));

  // Fallback to any audio-only format or best format with audio
  const bestAudio =
    audioFormats[0] ||
    formats.find((f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');

  const audioSizeBytes = getFormatSizeBytes(bestAudio, duration);
  const audioBitrateKbps = bestAudio ? Math.round(bestAudio.abr || (bestAudio.tbr || 128)) : 128;

  // Filter out storyboards (vcodec === 'none' AND acodec === 'none')
  const videoFormats = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.height);

  // Group video formats by height & fps
  const formatGroupMap = new Map<string, any[]>();
  for (const f of videoFormats) {
    const h = f.height;
    const fps = f.fps && f.fps > 30 ? Math.round(f.fps) : (f.fps ? Math.round(f.fps) : 30);
    const key = `${h}_${fps}`;
    if (!formatGroupMap.has(key)) {
      formatGroupMap.set(key, []);
    }
    formatGroupMap.get(key)!.push(f);
  }

  // Sort groups by height descending, then fps descending
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

    // Look for genuine non-HLS progressive format (standalone MP4 with both video and audio)
    const progressive = fmts.find(
      (f) =>
        f.url &&
        f.vcodec &&
        f.vcodec !== 'none' &&
        f.acodec &&
        f.acodec !== 'none' &&
        (!f.protocol || (!f.protocol.includes('m3u8') && !f.protocol.includes('m3u8_native')))
    );

    if (progressive) {
      const size = getFormatSizeBytes(progressive, duration);
      const uniqueId = `progressive_${h}p_${fps}fps`;

      qualities.push({
        id: uniqueId,
        height: h,
        fps,
        isHdr,
        vcodec: progressive.vcodec,
        acodec: progressive.acodec,
        label,
        type: 'standard',
        streamType: 'progressive',
        requiresMerge: false,
        canDirectDownload: true,
        mergeReason: 'Standard quality video and audio stream. Fast direct download.',
        ext: progressive.ext || 'mp4',
        url: progressive.url,
        note,
        size,
        formattedSize: formatBytes(size),
        format_id: progressive.format_id,
      });
    } else {
      // DASH stream (separate video + audio merged on server with FFmpeg)
      const httpDashFmts = fmts.filter((f) => !f.protocol || !f.protocol.includes('m3u8'));
      const candidateFmts = httpDashFmts.length > 0 ? httpDashFmts : fmts;

      candidateFmts.sort((a, b) => {
        const sizeA = getFormatSizeBytes(a, duration);
        const sizeB = getFormatSizeBytes(b, duration);
        return sizeB - sizeA;
      });

      const bestVideoFmt = candidateFmts.find((f) => f.ext === 'mp4') || candidateFmts[0];
      const videoSize = getFormatSizeBytes(bestVideoFmt, duration);
      const totalSize = videoSize > 0 ? videoSize + audioSizeBytes : 0;

      const combinedFormatId = bestAudio
        ? `${bestVideoFmt.format_id}+${bestAudio.format_id}`
        : `${bestVideoFmt.format_id}+bestaudio/bestvideo[height<=${h}]+bestaudio/best`;

      const uniqueId = `dash_${h}p_${fps}fps_${isHdr ? 'hdr' : 'sdr'}_${bestVideoFmt.format_id}`;

      qualities.push({
        id: uniqueId,
        height: h,
        fps,
        isHdr,
        vcodec: bestVideoFmt.vcodec,
        acodec: bestAudio?.acodec || 'aac',
        label,
        type: 'dash',
        streamType: 'dash',
        requiresMerge: true,
        canDirectDownload: false,
        mergeReason: `High quality video (${label}) and audio stream. Best visual experience.`,
        ext: 'mp4',
        video_url: bestVideoFmt.url,
        audio_url: bestAudio?.url,
        note,
        size: totalSize,
        formattedSize: formatBytes(totalSize),
        format_id: combinedFormatId,
      });
    }
  }

  // Audio Options
  const audioQualities: AudioOption[] = [
    {
      format: 'mp3',
      label: 'MP3 Audio (320 kbps)',
      bitrate: '320 kbps',
      note: 'Highest Audio Quality (VBR 0)',
      size: audioSizeBytes > 0 ? Math.round(audioSizeBytes * 1.05) : undefined,
      formattedSize: audioSizeBytes > 0 ? formatBytes(Math.round(audioSizeBytes * 1.05)) : undefined,
    },
    {
      format: 'm4a',
      label: 'M4A / AAC (Original)',
      bitrate: `${audioBitrateKbps} kbps`,
      note: 'Direct Original Stream (Zero Quality Loss)',
      size: audioSizeBytes > 0 ? audioSizeBytes : undefined,
      formattedSize: audioSizeBytes > 0 ? formatBytes(audioSizeBytes) : undefined,
    },
    {
      format: 'flac',
      label: 'FLAC Lossless Audio',
      bitrate: 'Lossless',
      note: 'Studio Quality Uncompressed',
      size: audioSizeBytes > 0 ? Math.round(audioSizeBytes * 2.2) : undefined,
      formattedSize: audioSizeBytes > 0 ? formatBytes(Math.round(audioSizeBytes * 2.2)) : undefined,
    },
    {
      format: 'wav',
      label: 'WAV Audio',
      bitrate: '1411 kbps',
      note: 'Uncompressed PCM Audio',
      size: audioSizeBytes > 0 ? Math.round(audioSizeBytes * 3.8) : undefined,
      formattedSize: audioSizeBytes > 0 ? formatBytes(Math.round(audioSizeBytes * 3.8)) : undefined,
    },
  ];

  const extractorKey = (info.extractor_key || info.extractor || '').toLowerCase();
  let platform = 'Universal';
  if (extractorKey.includes('youtube')) platform = 'YouTube';
  else if (extractorKey.includes('instagram')) platform = 'Instagram';
  else if (extractorKey.includes('tiktok')) platform = 'TikTok';
  else if (extractorKey.includes('twitter') || extractorKey.includes('x')) platform = 'Twitter / X';
  else if (extractorKey.includes('facebook')) platform = 'Facebook';
  else if (extractorKey.includes('reddit')) platform = 'Reddit';
  else if (extractorKey.includes('twitch')) platform = 'Twitch';

  if (qualities.length === 0) {
    qualities.push({
      id: 'fallback_best',
      height: 1080,
      fps: 30,
      label: 'Best Available Quality',
      type: 'standard',
      streamType: 'progressive',
      requiresMerge: false,
      canDirectDownload: true,
      ext: info.ext || 'mp4',
      url: info.url || videoUrl,
      note: 'Best Quality',
      format_id: 'best',
    });
  }

  const result: VideoExtractionResult = {
    title,
    thumbnail,
    duration,
    qualities,
    audioQualities,
    platform,
    extractor: info.extractor,
    url: videoUrl,
  };

  setCachedResult(videoUrl, result);
  return result;
}
