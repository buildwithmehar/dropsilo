import path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { sanitizeFilename } from '../utils/sanitizer';
import { fetchCdnStream } from './proxy.service';

export type DirectFile = {
  kind: 'file';
  category: 'video' | 'audio' | 'image' | 'document';
  filename: string;
  extension: string;
  contentType: string;
  size?: number;
};

export type DirectSource = DirectFile | { kind: 'hls' | 'dash'; filename: string };

const types: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  m4v: 'video/x-m4v', avi: 'video/x-msvideo', mpg: 'video/mpeg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  wav: 'audio/wav', opus: 'audio/opus', ogg: 'audio/ogg', m4b: 'audio/mp4',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', tif: 'image/tiff',
  pdf: 'application/pdf', epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook',
  zip: 'application/zip', txt: 'text/plain', csv: 'text/csv', srt: 'application/x-subrip',
  vtt: 'text/vtt', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const aliases: Record<string, string> = {
  'audio/x-wav': 'audio/wav', 'audio/x-flac': 'audio/flac', 'audio/x-m4a': 'audio/mp4',
  'application/x-zip-compressed': 'application/zip', 'application/ogg': 'audio/ogg',
};

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function describeDirectSource(url: string, headers: IncomingHttpHeaders): DirectSource | null {
  const disposition = headers['content-disposition'] || '';
  const encodedName = /(?:^|;)\s*filename\*=UTF-8'[^']*'([^;]+)/i.exec(disposition)?.[1];
  const basicName = /(?:^|;)\s*filename=(?:"([^"]+)"|([^;]+))/i.exec(disposition);
  const urlName = path.posix.basename(new URL(url).pathname);
  const rawName = encodedName ? decode(encodedName.trim()) : (basicName?.[1] || basicName?.[2]?.trim() || decode(urlName));
  const filename = sanitizeFilename(rawName, 'download');
  const givenExtension = path.extname(filename).slice(1).toLowerCase();
  const headerType = headers['content-type']?.split(';', 1)[0].trim().toLowerCase() || '';
  const contentType = Object.hasOwn(aliases, headerType) ? aliases[headerType] : headerType;
  const generic = !contentType || contentType === 'application/octet-stream';
  const manifestType = contentType === 'application/dash+xml' ? 'dash'
    : /^(application|audio)\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl)$/.test(contentType) ? 'hls' : null;

  if (manifestType || ((generic || contentType === 'text/plain' || contentType === 'text/xml' || contentType === 'application/xml')
      && ['m3u8', 'mpd'].includes(givenExtension))) {
    return { kind: manifestType || (givenExtension === 'mpd' ? 'dash' : 'hls'), filename: filename.replace(/\.(m3u8|mpd)$/i, '') + '.mp4' };
  }
  // A text response could be an error message for a binary URL.
  if (contentType === 'text/plain' && givenExtension !== 'txt' && !/^attachment\b/i.test(disposition)) return null;
  const extension = generic || Object.hasOwn(types, givenExtension) && types[givenExtension] === contentType
    ? givenExtension : Object.keys(types).find((key) => types[key] === contentType);
  if (!extension || !Object.hasOwn(types, extension)) return null;
  const mime = types[extension];
  const category = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio'
    : mime.startsWith('image/') ? 'image' : 'document';
  const sizeHeader = headers['content-range']?.split('/').pop() || headers['content-length'];
  const size = sizeHeader && /^\d+$/.test(sizeHeader) ? Number(sizeHeader) : undefined;
  return {
    kind: 'file', category, extension, contentType: mime,
    filename: givenExtension === extension ? filename : (path.parse(filename).name || 'download') + '.' + extension,
    size: Number.isSafeInteger(size) && size! > 0 ? size : undefined,
  };
}

export function isLiveChannel(url: string): boolean {
  const { hostname, pathname } = new URL(url);
  const host = hostname.replace(/^www\./, '').toLowerCase();
  return ['twitch.tv', 'kick.com'].includes(host)
    && /^\/[a-zA-Z0-9_][a-zA-Z0-9_-]{0,49}\/?$/.test(pathname)
    && !/^\/(directory|downloads|about|videos|clips|search|settings|categories|browse|following|subscriptions|jobs|turbo|inventory|wallet)\/?$/i.test(pathname);
}

export function resolvePublicDocumentUrl(url: string): string {
  const { hostname, pathname } = new URL(url);
  const host = hostname.replace(/^www\./, '');
  if (host === 'arxiv.org') {
    const id = /^\/abs\/((?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v\d+)?)\/?$/i.exec(pathname)?.[1];
    if (id) return 'https://arxiv.org/pdf/' + id;
  }
  if (host === 'gutenberg.org') {
    const id = /^\/ebooks\/(\d{1,9})\/?$/.exec(pathname)?.[1];
    if (id) return 'https://www.gutenberg.org/ebooks/' + id + '.epub3.images';
  }
  return url;
}

export async function probeDirectSource(url: string, signal?: AbortSignal): Promise<DirectSource | null> {
  const timeout = AbortSignal.timeout(6_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const head = await fetchCdnStream(url, { 'Accept-Encoding': 'identity' }, 6, { method: 'HEAD', signal: combined });
  head.stream.destroy();
  if (head.statusCode >= 200 && head.statusCode < 300) {
    const result = describeDirectSource(head.finalUrl, head.headers);
    if (result || head.headers['content-type']) return result;
  } else if (![400, 403, 405, 501].includes(head.statusCode)) {
    return null;
  }
  const range = await fetchCdnStream(url, { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' }, 6, { signal: combined });
  range.stream.destroy();
  return range.statusCode >= 200 && range.statusCode < 300 ? describeDirectSource(range.finalUrl, range.headers) : null;
}
