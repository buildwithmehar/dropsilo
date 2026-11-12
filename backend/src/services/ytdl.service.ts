import path from 'path';
import fs from 'fs';

/**
 * Binary-path resolution helpers and re-exports.
 *
 * The heavy lifting (yt-dlp invocation, format parsing, proxy rotation,
 * cookie file support) lives in `services/ytdl-runner.ts` so the queue
 * adapters can share one canonical implementation. This module remains
 * for backwards compatibility with imports like:
 *
 *   import { getYtDlpPath, getFfmpegPath, extractMediaInfo } from '../services/ytdl.service';
 */

export function getFfmpegPath(): string {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic)) {
      return ffmpegStatic;
    }
  } catch {}
  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const localBinPath = path.resolve(process.cwd(), 'bin', binaryName);
  if (fs.existsSync(localBinPath)) return localBinPath;
  if (fs.existsSync('/usr/local/bin/ffmpeg')) return '/usr/local/bin/ffmpeg';
  if (fs.existsSync('/usr/bin/ffmpeg')) return '/usr/bin/ffmpeg';
  return binaryName;
}

export function getYtDlpPath(): string {
  if (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH)) {
    return process.env.YTDLP_PATH;
  }
  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const localBinPath = path.resolve(process.cwd(), 'bin', binaryName);
  if (fs.existsSync(localBinPath)) return localBinPath;
  if (fs.existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp';
  if (fs.existsSync('/usr/bin/yt-dlp')) return '/usr/bin/yt-dlp';
  return binaryName;
}

export function getAria2cPath(): string | null {
  if (process.env.ARIA2C_PATH && fs.existsSync(process.env.ARIA2C_PATH)) {
    return process.env.ARIA2C_PATH;
  }
  const binaryName = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';
  const localBinPath = path.resolve(process.cwd(), 'bin', binaryName);
  if (fs.existsSync(localBinPath)) return localBinPath;
  if (fs.existsSync('/usr/local/bin/aria2c')) return '/usr/local/bin/aria2c';
  if (fs.existsSync('/usr/bin/aria2c')) return '/usr/bin/aria2c';
  return null;
}

export function getGalleryDlCommand(): { command: string; argsPrefix: string[] } {
  if (process.env.GALLERY_DL_PATH && fs.existsSync(process.env.GALLERY_DL_PATH)) {
    return { command: process.env.GALLERY_DL_PATH, argsPrefix: [] };
  }
  const binaryName = process.platform === 'win32' ? 'gallery-dl.exe' : 'gallery-dl';
  const localBinPath = path.resolve(process.cwd(), 'bin', binaryName);
  if (fs.existsSync(localBinPath)) return { command: localBinPath, argsPrefix: [] };
  if (fs.existsSync('/usr/local/bin/gallery-dl')) return { command: '/usr/local/bin/gallery-dl', argsPrefix: [] };
  if (fs.existsSync('/usr/bin/gallery-dl')) return { command: '/usr/bin/gallery-dl', argsPrefix: [] };
  // Fallback to Python module
  return { command: 'python', argsPrefix: ['-m', 'gallery_dl'] };
}

// Types (kept here so callers do not need to know about ytdl-runner)
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

// Re-export everything from the runner
export {
  extractMediaInfo,
  dumpVideoJson,
  buildDownloadArgs,
  classifyYtDlpError,
  expandPlaylistUrl,
} from './ytdl-runner';
