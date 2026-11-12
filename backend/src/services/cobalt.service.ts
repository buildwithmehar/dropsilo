import https from 'https';
import http from 'http';
import { URL } from 'url';
import { CONFIG } from '../config';
import { AudioOption, RealQuality, VideoExtractionResult } from './ytdl.service';

export interface CobaltRequestOptions {
  url: string;
  vQuality?: 'max' | '1080' | '720' | '480' | '360' | '240' | '144';
  vCodec?: 'h264' | 'av1' | 'vp9';
  vFormat?: 'mp4' | 'webm';
  aFormat?: 'mp3' | 'opus' | 'ogg' | 'wav';
  isAudioOnly?: boolean;
  isAudioMuted?: boolean;
  filenamePattern?: 'classic' | 'pretty' | 'basic' | 'nerdy';
  disableMetadata?: boolean;
}

export interface CobaltPickerItem {
  type: 'photo' | 'video' | 'gif';
  url: string;
  thumb?: string;
}

export interface CobaltResponse {
  status: 'stream' | 'redirect' | 'tunnel' | 'picker' | 'error';
  url?: string;
  filename?: string;
  picker?: CobaltPickerItem[];
  error?: {
    code: string;
    context?: any;
  };
  text?: string;
}

/**
 * Checks if a given media URL is natively supported by Cobalt.
 */
export function isCobaltSupported(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const supportedDomains = [
      'youtube.com',
      'youtu.be',
      'tiktok.com',
      'instagram.com',
      'twitter.com',
      'x.com',
      'reddit.com',
      'v.redd.it',
      'vimeo.com',
      'dailymotion.com',
      'dai.ly',
      'bilibili.com',
      'loom.com',
      'rutube.ru',
      'vk.com',
      'streamable.com',
      'tumblr.com',
      'pinterest.com',
      'pin.it',
      'soundcloud.com',
    ];
    return supportedDomains.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

/**
 * Sends a request to the configured Cobalt API instance.
 */
export async function requestCobalt(opts: CobaltRequestOptions): Promise<CobaltResponse> {
  const cobaltUrl = CONFIG.COBALT_API_URL;
  if (!cobaltUrl) {
    throw new Error('Cobalt is not configured (COBALT_API_URL is empty).');
  }

  const parsedUrl = new URL(cobaltUrl);
  // Support base URL or explicit /api/json /
  const path = parsedUrl.pathname === '/' || !parsedUrl.pathname ? '/' : parsedUrl.pathname;
  const isHttps = parsedUrl.protocol === 'https:';
  const client = isHttps ? https : http;

  const payload = JSON.stringify({
    url: opts.url,
    vQuality: opts.vQuality || 'max',
    vCodec: opts.vCodec || 'h264',
    vFormat: opts.vFormat || 'mp4',
    aFormat: opts.aFormat || 'mp3',
    isAudioOnly: Boolean(opts.isAudioOnly),
    isAudioMuted: Boolean(opts.isAudioMuted),
    filenamePattern: opts.filenamePattern || 'classic',
    disableMetadata: Boolean(opts.disableMetadata),
  });

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'EasySave/2.0 (High-Speed Universal Downloader)',
    'Content-Length': String(Buffer.byteLength(payload)),
  };

  if (CONFIG.COBALT_API_KEY) {
    headers['Authorization'] = `Bearer ${CONFIG.COBALT_API_KEY}`;
    headers['Api-Key'] = CONFIG.COBALT_API_KEY;
  }

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path,
        method: 'POST',
        headers,
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const data: CobaltResponse = JSON.parse(body);
            if (res.statusCode && res.statusCode >= 400) {
              const code = data.error?.code || data.text || `HTTP ${res.statusCode}`;
              return reject(new Error(`Cobalt API error: ${code}`));
            }
            if (data.status === 'error') {
              const code = data.error?.code || data.text || 'Unknown Cobalt error';
              return reject(new Error(`Cobalt error: ${code}`));
            }
            resolve(data);
          } catch (e: any) {
            reject(new Error(`Invalid JSON from Cobalt (${res.statusCode}): ${body.slice(0, 100)}`));
          }
        });
      }
    );

    req.on('error', (err) => reject(new Error(`Cobalt connection error: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Cobalt request timed out (8s limit).'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Detects platform name from URL for Cobalt results.
 */
function detectCobaltPlatform(url: string): string {
  const l = url.toLowerCase();
  if (l.includes('tiktok.com')) return 'TikTok';
  if (l.includes('instagram.com')) return 'Instagram';
  if (l.includes('twitter.com') || l.includes('x.com')) return 'Twitter / X';
  if (l.includes('reddit.com') || l.includes('v.redd.it')) return 'Reddit';
  if (l.includes('youtube.com') || l.includes('youtu.be')) return 'YouTube';
  if (l.includes('vimeo.com')) return 'Vimeo';
  if (l.includes('bilibili.com')) return 'Bilibili';
  if (l.includes('soundcloud.com')) return 'SoundCloud';
  if (l.includes('pinterest.com') || l.includes('pin.it')) return 'Pinterest';
  return 'Media Stream';
}

/**
 * Extracts unified media information via Cobalt for high-speed resolution.
 */
export async function extractCobaltMediaInfo(
  url: string
): Promise<VideoExtractionResult & { isGallery?: boolean; images?: any[]; totalImages?: number }> {
  const platform = detectCobaltPlatform(url);

  // Request standard max quality probe
  const cobaltRes = await requestCobalt({
    url,
    vQuality: 'max',
    vCodec: 'h264',
  });

  // Handle Multi-Item / Carousel Picker
  if (cobaltRes.status === 'picker' && cobaltRes.picker && cobaltRes.picker.length > 0) {
    const images = cobaltRes.picker.map((item, idx) => ({
      id: `cobalt_item_${idx + 1}`,
      url: item.url,
      thumbnailUrl: item.thumb || item.url,
      filename: `media_${idx + 1}.${item.type === 'photo' ? 'jpg' : 'mp4'}`,
      extension: item.type === 'photo' ? 'jpg' : 'mp4',
    }));

    return {
      title: `${platform} Album (${images.length} items)`,
      thumbnail: images[0]?.thumbnailUrl || images[0]?.url || '',
      duration: 0,
      platform,
      url,
      qualities: [],
      audioQualities: [],
      isGallery: true,
      images,
      totalImages: images.length,
    };
  }

  // Single Video / Direct Stream
  const downloadUrl = cobaltRes.url || '';
  const title = cobaltRes.filename
    ? cobaltRes.filename.replace(/\.[^.]+$/, '').replace(/_/g, ' ')
    : `${platform} HD Media`;

  const standardQualities: RealQuality[] = [
    {
      id: 'cobalt_max',
      format_id: 'max',
      label: 'Max Quality (HD+)',
      ext: 'mp4',
      height: 1080,
      fps: 60,
      vcodec: 'h264',
      acodec: 'aac',
      type: 'standard',
      streamType: 'progressive',
      requiresMerge: false,
      canDirectDownload: true,
      url: downloadUrl,
    },
    {
      id: 'cobalt_1080',
      format_id: '1080',
      label: '1080p Full HD',
      ext: 'mp4',
      height: 1080,
      fps: 30,
      vcodec: 'h264',
      acodec: 'aac',
      type: 'standard',
      streamType: 'progressive',
      requiresMerge: false,
      canDirectDownload: true,
    },
    {
      id: 'cobalt_720',
      format_id: '720',
      label: '720p HD',
      ext: 'mp4',
      height: 720,
      fps: 30,
      vcodec: 'h264',
      acodec: 'aac',
      type: 'standard',
      streamType: 'progressive',
      requiresMerge: false,
      canDirectDownload: true,
    },
    {
      id: 'cobalt_480',
      format_id: '480',
      label: '480p Standard',
      ext: 'mp4',
      height: 480,
      fps: 30,
      vcodec: 'h264',
      acodec: 'aac',
      type: 'standard',
      streamType: 'progressive',
      requiresMerge: false,
      canDirectDownload: true,
    },
  ];

  const standardAudio: AudioOption[] = [
    {
      format: 'mp3',
      label: 'MP3 Audio (High Quality)',
      bitrate: '320 kbps',
      note: 'Universal audio playback',
    },
    {
      format: 'm4a',
      label: 'M4A / AAC Audio',
      bitrate: '256 kbps',
      note: 'Apple & mobile native',
    },
    {
      format: 'wav',
      label: 'WAV Lossless Audio',
      bitrate: '1411 kbps',
      note: 'Uncompressed master',
    },
    {
      format: 'opus',
      label: 'Opus Modern Audio',
      bitrate: '160 kbps',
      note: 'High efficiency codec',
    },
  ];

  return {
    title,
    thumbnail: '',
    duration: 0,
    platform,
    url,
    qualities: standardQualities,
    audioQualities: standardAudio,
  };
}

/**
 * Resolves direct stream download link for a given quality / audio mode.
 */
export async function getCobaltDirectStream(
  url: string,
  quality: 'max' | '1080' | '720' | '480' | '360' = 'max',
  isAudioOnly = false,
  audioFormat: 'mp3' | 'opus' | 'wav' = 'mp3'
): Promise<{ url: string; filename: string }> {
  const res = await requestCobalt({
    url,
    vQuality: quality,
    isAudioOnly,
    aFormat: audioFormat,
  });

  if (!res.url) {
    throw new Error('Cobalt did not return a valid stream URL.');
  }

  return {
    url: res.url,
    filename: res.filename || `easysave_${Date.now()}.${isAudioOnly ? audioFormat : 'mp4'}`,
  };
}
