import https from 'https';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { VideoExtractionResult, AudioOption, getFfmpegPath, getYtDlpPath } from './ytdl.service';
import { CONFIG } from '../config';

const execFileAsync = promisify(execFile);

export interface SpotifyTrackInfo {
  id: string;
  type: 'track' | 'album' | 'playlist';
  title: string;
  artist: string;
  album?: string;
  durationSec: number;
  coverUrl: string;
  releaseDate?: string;
  trackList?: Array<{
    id: string;
    title: string;
    artist: string;
    durationSec: number;
    url: string;
  }>;
}

export function isSpotifyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('spotify.com') || parsed.hostname.includes('spotify.link');
  } catch {
    return false;
  }
}

export function parseSpotifyUrl(url: string): { type: 'track' | 'album' | 'playlist'; id: string } | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    // Path might be /track/ID or /intl-es/track/ID
    const typeIdx = parts.findIndex((p) => ['track', 'album', 'playlist'].includes(p));
    if (typeIdx !== -1 && parts[typeIdx + 1]) {
      return {
        type: parts[typeIdx] as 'track' | 'album' | 'playlist',
        id: parts[typeIdx + 1].split('?')[0],
      };
    }
    return null;
  } catch {
    return null;
  }
}

function fetchHttps(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return resolve(fetchHttps(res.headers.location));
          }
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve(body));
        }
      )
      .on('error', reject);
  });
}

/** Extract full metadata from Spotify Embed serialized data. */
export async function getSpotifyInfo(url: string): Promise<SpotifyTrackInfo> {
  const parsed = parseSpotifyUrl(url);
  if (!parsed) {
    throw new Error('Invalid Spotify URL. Please provide a track, album, or playlist link.');
  }

  const embedUrl = `https://open.spotify.com/embed/${parsed.type}/${parsed.id}`;
  const html = await fetchHttps(embedUrl);

  const idx = html.indexOf('__NEXT_DATA__');
  if (idx === -1) {
    // Fallback to oEmbed if __NEXT_DATA__ is not present
    return getSpotifyInfoViaOembed(url, parsed.type, parsed.id);
  }

  try {
    const start = html.indexOf('>', idx) + 1;
    const end = html.indexOf('</script>', start);
    const json = JSON.parse(html.slice(start, end));
    const ent = json.props?.pageProps?.state?.data?.entity;

    if (!ent) {
      return getSpotifyInfoViaOembed(url, parsed.type, parsed.id);
    }

    let coverUrl =
      ent.visualIdentity?.image?.find((img: any) => img.maxHeight >= 600)?.url ||
      ent.visualIdentity?.image?.[0]?.url ||
      ent.coverArt?.sources?.[0]?.url ||
      '';

    const artistName = Array.isArray(ent.artists)
      ? ent.artists.map((a: any) => a.name).join(', ')
      : ent.subtitle || 'Spotify Artist';

    const durationSec = ent.duration ? Math.round(ent.duration / 1000) : 180;

    let trackList: SpotifyTrackInfo['trackList'];
    if (Array.isArray(ent.trackList) && ent.trackList.length > 0) {
      trackList = ent.trackList.map((t: any) => ({
        id: t.id || t.uri?.split(':').pop() || '',
        title: t.title || t.name || 'Track',
        artist: t.subtitle || artistName,
        durationSec: t.duration ? Math.round(t.duration / 1000) : 180,
        url: `https://open.spotify.com/track/${t.id || t.uri?.split(':').pop()}`,
      }));
    }

    return {
      id: parsed.id,
      type: parsed.type,
      title: ent.name || ent.title || 'Spotify Audio',
      artist: artistName,
      album: ent.album?.name,
      durationSec,
      coverUrl,
      releaseDate: ent.releaseDate?.isoString?.split('T')[0],
      trackList,
    };
  } catch {
    return getSpotifyInfoViaOembed(url, parsed.type, parsed.id);
  }
}

async function getSpotifyInfoViaOembed(
  url: string,
  type: 'track' | 'album' | 'playlist',
  id: string
): Promise<SpotifyTrackInfo> {
  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  const jsonStr = await fetchHttps(oembedUrl);
  const data = JSON.parse(jsonStr);

  return {
    id,
    type,
    title: data.title || 'Spotify Track',
    artist: data.author_name || 'Spotify Artist',
    durationSec: 180,
    coverUrl: data.thumbnail_url || '',
  };
}

/** Formats Spotify metadata as standard VideoExtractionResult for the frontend */
export function formatSpotifyExtraction(info: SpotifyTrackInfo, originalUrl: string): VideoExtractionResult {
  const audioQualities: AudioOption[] = [
    {
      format: 'mp3',
      label: 'MP3 Audio (320 kbps)',
      bitrate: '320 kbps',
      note: 'Studio Master Quality',
      formattedSize: `~${Math.round((info.durationSec * 320) / 8 / 1024)} MB`,
    },
    {
      format: 'm4a',
      label: 'M4A / AAC (256 kbps)',
      bitrate: '256 kbps',
      note: 'Apple Lossless Profile',
      formattedSize: `~${Math.round((info.durationSec * 256) / 8 / 1024)} MB`,
    },
    {
      format: 'flac',
      label: 'FLAC Lossless',
      bitrate: 'Lossless',
      note: 'Hi-Res Audio',
      formattedSize: `~${Math.round((info.durationSec * 800) / 8 / 1024)} MB`,
    },
    {
      format: 'wav',
      label: 'WAV PCM',
      bitrate: '1411 kbps',
      note: 'Uncompressed Studio',
      formattedSize: `~${Math.round((info.durationSec * 1411) / 8 / 1024)} MB`,
    },
  ];

  return {
    title: `${info.artist} - ${info.title}`,
    thumbnail: info.coverUrl,
    duration: info.durationSec,
    platform: 'Spotify',
    extractor: 'Spotify',
    url: originalUrl,
    qualities: [],
    audioQualities,
  };
}

/**
 * Downloads matched high-quality audio stream for a Spotify track and embeds ID3 tags and cover art.
 */
export async function downloadSpotifyTrackAudio(opts: {
  trackInfo: SpotifyTrackInfo;
  format: string; // mp3, m4a, flac, wav
  outputFilePath: string;
  tempDir: string;
}): Promise<string> {
  const { trackInfo, format, outputFilePath, tempDir } = opts;
  const ytDlp = getYtDlpPath();
  const ffmpeg = getFfmpegPath();

  const searchQuery = `ytsearch1:${trackInfo.artist} - ${trackInfo.title} Official Audio`;
  const rawAudioPath = path.join(tempDir, `spotify_raw_${Date.now()}.webm`);

  // 1. Download best audio stream matching the song
  const dlArgs = [
    '--no-config',
    '--no-playlist',
    '--extract-audio',
    '--format',
    'bestaudio/best',
    '-o',
    rawAudioPath,
    searchQuery,
  ];

  if (fs.existsSync(ffmpeg)) {
    dlArgs.push('--ffmpeg-location', path.dirname(ffmpeg));
  }

  await execFileAsync(ytDlp, dlArgs, { timeout: 180000 });

  // 2. Download Spotify cover art image to embed
  let coverImagePath = '';
  if (trackInfo.coverUrl) {
    try {
      coverImagePath = path.join(tempDir, `cover_${Date.now()}.jpg`);
      await new Promise<void>((resolve, reject) => {
        https
          .get(trackInfo.coverUrl, (res) => {
            const stream = fs.createWriteStream(coverImagePath);
            res.pipe(stream);
            stream.on('finish', () => resolve());
            stream.on('error', reject);
          })
          .on('error', reject);
      });
    } catch {}
  }

  // 3. Encode & Tag via FFmpeg with ID3 tags & Cover Art
  const ffmpegArgs = ['-y', '-i', rawAudioPath];

  if (coverImagePath && fs.existsSync(coverImagePath)) {
    ffmpegArgs.push('-i', coverImagePath, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
  }

  // Metadata tags
  ffmpegArgs.push(
    '-metadata',
    `title=${trackInfo.title}`,
    '-metadata',
    `artist=${trackInfo.artist}`,
    '-metadata',
    `album=${trackInfo.album || trackInfo.title}`,
    '-metadata',
    `date=${trackInfo.releaseDate || new Date().getFullYear()}`,
    '-metadata',
    `comment=Downloaded with DropSilo`
  );

  if (format === 'mp3') {
    ffmpegArgs.push('-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3');
  } else if (format === 'm4a') {
    ffmpegArgs.push('-c:a', 'aac', '-b:a', '256k');
  } else if (format === 'flac') {
    ffmpegArgs.push('-c:a', 'flac');
  } else if (format === 'wav') {
    ffmpegArgs.push('-c:a', 'pcm_s16le');
  } else {
    ffmpegArgs.push('-c:a', 'libmp3lame', '-b:a', '320k');
  }

  ffmpegArgs.push(outputFilePath);

  await execFileAsync(ffmpeg, ffmpegArgs, { timeout: 120000 });

  // Cleanup temp files
  try {
    if (fs.existsSync(rawAudioPath)) fs.unlinkSync(rawAudioPath);
    if (coverImagePath && fs.existsSync(coverImagePath)) fs.unlinkSync(coverImagePath);
  } catch {}

  return outputFilePath;
}
