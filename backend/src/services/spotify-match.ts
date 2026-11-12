import path from 'node:path';
import { sanitizeFilename } from '../utils/sanitizer';
import { exec } from './source-engines';
import { getSpotifyInfo } from './spotify.service';
import { getFfmpegPath, getYtDlpPath } from './ytdl.service';

type Track = { title: string; artist: string; durationSec: number };
type Candidate = { id?: string; title?: string; duration?: number; uploader?: string; channel?: string };

function words(value: unknown) {
  return (typeof value === 'string' ? value : '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function includesWords(text: string, phrase: string) {
  return !!phrase && (' ' + text + ' ').includes(' ' + phrase + ' ');
}

export function selectSpotifyAudioMatch(track: Track, entries: Candidate[]) {
  const title = words(track.title);
  const artist = words(track.artist);
  if (!title || !artist || !(track.durationSec > 0)) return;
  const tolerance = Math.max(5, Math.min(12, track.durationSec * 0.05));
  const variants = ['cover', 'karaoke', 'slowed', 'remix', 'reaction', 'nightcore', 'sped', 'loop', 'instrumental', 'live'];
  return entries.find((entry) => {
    if (!entry?.id || !/^[\w-]{11}$/.test(entry.id) || typeof entry.duration !== 'number' || !Number.isFinite(entry.duration) ||
        Math.abs(entry.duration - track.durationSec) > tolerance) return false;
    const name = words(entry.title);
    if (!includesWords(name, title)) return false;
    if (variants.some((variant) => includesWords(name, variant) && !includesWords(title, variant))) return false;
    return [name, words(entry.uploader), words(entry.channel)].some((field) => includesWords(field, artist));
  });
}

export async function downloadMatchedSpotifyTrack(url: string, work: string, output: string, proxy: string, signal: AbortSignal) {
  const track = await getSpotifyInfo(url);
  signal.throwIfAborted();
  const yt = getYtDlpPath();
  const ffmpeg = getFfmpegPath();
  const options = { cwd: work, signal, timeout: 50_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
  const common = ['--no-config', '--no-exec', '--proxy', proxy, '--socket-timeout', '12', '--retries', '1'];
  const { stdout } = await exec(yt, [...common, '--flat-playlist', '--dump-single-json', '--',
    `ytsearch8:${track.artist} ${track.title} official audio`], options);
  const search = JSON.parse(stdout) as { entries?: Candidate[] };
  const match = selectSpotifyAudioMatch(track, search.entries || []);
  if (!match) throw new Error('No public audio matched the Spotify title, artist, and duration.');

  await exec(yt, [...common, '--no-playlist', '--ffmpeg-location', ffmpeg, '-f', 'bestaudio/best',
    '--extract-audio', '--audio-format', 'mp3', '-o', path.join(work, 'spotify-source.%(ext)s'),
    '--', 'https://www.youtube.com/watch?v=' + match.id], options);
  const filename = sanitizeFilename(track.artist + ' - ' + track.title, 'spotify-track') + '.mp3';
  await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    '-i', path.join(work, 'spotify-source.mp3'), '-map', '0:a:0', '-c:a', 'copy',
    '-metadata', 'title=' + track.title, '-metadata', 'artist=' + track.artist,
    '-metadata', 'album=' + (track.album || track.title), path.join(output, filename)], options);
}
