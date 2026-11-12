import fs from 'fs';
import path from 'path';
import { finished } from 'node:stream/promises';
import { fetchCdnStream } from './proxy.service';
import { openEngineProxy } from './engine-proxy';
import { exec, getGalleryEnginePath } from './source-engines';
import { describeDirectSource } from './source-discovery';
import { sanitizeFilename } from '../utils/sanitizer';

export interface GalleryItem {
  id: string;
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  filename: string;
  extension: string;
}

export interface GalleryExtractionResult {
  title: string;
  thumbnail: string;
  platform: 'Pinterest' | 'Instagram' | 'Reddit' | 'Imgur' | 'Twitter' | 'Gallery';
  url: string;
  totalImages: number;
  images: GalleryItem[];
}

export function isGalleryUrl(url: string, includeMixedPosts = false): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (isPinterestHost(host)) return true;
    if (/(^|\.)imgur\.com$/.test(host)) return true;
    if (/(^|\.)reddit\.com$/.test(host) && (/\/gallery\//.test(pathname) || includeMixedPosts && /\/comments\//.test(pathname))) return true;
    if (/(^|\.)(deviantart\.com|artstation\.com|pixiv\.net|flickr\.com)$/.test(host)) return true;
    if (includeMixedPosts && /(^|\.)(x\.com|twitter\.com|instagram\.com)$/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

function isPinterestHost(host: string): boolean {
  return /(^|\.)(pinterest\.(com(\.(au|br|mx))?|co\.(uk|nz)|ca|de|fr|es|it|ch|jp|se|pt|ph|nz|at|dk|cl|ie|kr)|pin\.it)$/.test(host);
}

export function detectGalleryPlatform(url: string): GalleryExtractionResult['platform'] {
  const host = new URL(url).hostname.toLowerCase();
  if (isPinterestHost(host)) return 'Pinterest';
  if (/(^|\.)reddit\.com$/.test(host)) return 'Reddit';
  if (/(^|\.)instagram\.com$/.test(host)) return 'Instagram';
  if (/(^|\.)imgur\.com$/.test(host)) return 'Imgur';
  if (/(^|\.)(twitter\.com|x\.com)$/.test(host)) return 'Twitter';
  return 'Gallery';
}

async function readBounded(stream: NodeJS.ReadableStream & { destroy(): unknown }, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > limit) throw new Error('Gallery response exceeds its size limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    stream.destroy();
  }
}

async function fetchPinterestPage(url: string) {
  const response = await fetchCdnStream(url, {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Encoding': 'identity',
  }, 5, { signal: AbortSignal.timeout(12_000) });
  if (response.statusCode !== 200 || !isPinterestHost(new URL(response.finalUrl).hostname)) {
    response.stream.destroy();
    throw new Error('Pinterest did not return a public gallery.');
  }
  return { finalUrl: response.finalUrl, body: (await readBounded(response.stream, 8 * 1024 * 1024)).toString() };
}

/**
 * Direct native Pinterest extractor (supports short pin.it, image pins, video pins, boards, and clusters).
 */
export async function extractPinterestDirect(url: string): Promise<GalleryExtractionResult> {
  const { finalUrl, body } = await fetchPinterestPage(url);

  // Unescape JSON-encoded slashes & unicode entities
  const cleanBody = body
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&');

  // 1. Extract Clean Title
  let title = 'Pinterest Pin';
  const ogTitleMatch =
    cleanBody.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1] ||
    cleanBody.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i)?.[1] ||
    cleanBody.match(/<title>([^<]+)<\/title>/i)?.[1];

  if (ogTitleMatch) {
    title = ogTitleMatch
      .replace(/\s*\|\s*Pinterest.*$/i, '')
      .replace(/\s*-\s*Pinterest.*$/i, '')
      .trim();
  }

  // 2. High-Res Images across all dimensions (originals, 1200x, 736x, 564x, 474x, 236x, 170x)
  const PINTEREST_IGNORE_HASHES = new Set([
    'd53b014d86a6b6761bf649a0ed813c2b', // Pinterest gradient UI placeholder
    '7b6d13e01a88b5608b49e6f3b06bc9a0',
    '75747051410292bbf8a5948332158913',
  ]);

  // Extract main og:image if present to prioritize the primary pin image
  const ogImgMatch =
    cleanBody.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1] ||
    cleanBody.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i)?.[1];

  const rawImages = [
    ...new Set(
      cleanBody.match(/https:\/\/i\.pinimg\.com\/(?:originals|1200x|736x|564x|474x|236x|170x)\/[^\s"'<>\\]+\.(?:jpg|jpeg|png|webp)/gi) || []
    ),
  ];

  const imageMap = new Map<string, string>();

  // Prioritize og:image if available
  if (ogImgMatch && /^https:\/\/i\.pinimg\.com\//i.test(ogImgMatch) && !ogImgMatch.includes('d53b014d86a6b6761bf649a0ed813c2b')) {
    const cleanOg = ogImgMatch.replace(/\/(?:1200x|736x|564x|474x|236x|170x)\//, '/originals/');
    const filename = cleanOg.split('/').pop()?.split('?')[0] || 'pin_main.jpg';
    imageMap.set(filename, cleanOg);
  }

  for (const img of rawImages) {
    const filename = img.split('/').pop()?.split('?')[0] || `pin_image_${imageMap.size + 1}.jpg`;
    const basename = filename.replace(/\.[^.]+$/, '');
    if (PINTEREST_IGNORE_HASHES.has(basename)) continue;

    // Upgrade any scaled resolution thumbnail to the full-resolution uncompressed original
    const origUrl = img.replace(/\/(?:1200x|736x|564x|474x|236x|170x)\//, '/originals/');
    if (!imageMap.has(filename)) {
      imageMap.set(filename, origUrl);
    }
  }

  // Fallback: if everything was filtered, retain the first image
  if (imageMap.size === 0 && rawImages.length > 0) {
    const fallbackImg = rawImages[0].replace(/\/(?:1200x|736x|564x|474x|236x|170x)\//, '/originals/');
    const filename = fallbackImg.split('/').pop()?.split('?')[0] || 'pin_image_1.jpg';
    imageMap.set(filename, fallbackImg);
  }

  const images: GalleryItem[] = Array.from(imageMap.entries()).slice(0, 50).map(([filename, imgUrl], idx) => {
    const ext = path.extname(filename).replace('.', '') || 'jpg';
    return {
      id: `pin_img_${idx + 1}`,
      url: imgUrl,
      thumbnailUrl: imgUrl,
      filename,
      extension: ext,
    };
  });

  if (images.length === 0) {
    throw new Error('No downloadable media found for this Pinterest link.');
  }

  return {
    title,
    thumbnail: images[0].thumbnailUrl || images[0].url,
    platform: 'Pinterest',
    url: finalUrl || url,
    totalImages: images.length,
    images,
  };
}

/**
 * Extracts all image URLs and metadata using native scrapers with gallery-dl fallback.
 */
export async function extractGalleryInfo(url: string): Promise<GalleryExtractionResult> {
  const platform = detectGalleryPlatform(url);

  // ── Native Pinterest Handler (100% Reliable & Fast) ──
  if (platform === 'Pinterest') {
    try {
      return await extractPinterestDirect(url);
    } catch (pinErr: any) {
      // Fallback to gallery-dl if native fails
    }
  }

  const command = getGalleryEnginePath();
  if (!command) throw new Error('gallery-dl is not installed.');
  const proxy = await openEngineProxy(AbortSignal.timeout(24_000), 64 * 1024 * 1024);
  let stdout: string;
  try {
    ({ stdout } = await exec(command, [
      '--config-ignore', '--proxy', proxy.url, '--range', '1-50', '-j', '--no-download', '--', url,
    ], { signal: proxy.signal, maxBuffer: 4 * 1024 * 1024, windowsHide: true }));
  } finally { proxy.close(); }
  let entries: unknown[];
  try { entries = JSON.parse(stdout); }
  catch {
    entries = stdout.trim().split('\n').flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
  const images: GalleryItem[] = [];
  const seen = new Set<string>();

  let extractedTitle = `${platform} Gallery`;

  for (const parsed of Array.isArray(entries) ? entries : []) {
    try {
      if (Array.isArray(parsed) && parsed[0] === 3) {
        const [, directUrl, meta = {}] = parsed;

        if (typeof directUrl === 'string' && /^https?:\/\//i.test(directUrl) && !seen.has(directUrl)) {
          if (typeof meta.title === 'string' && extractedTitle === `${platform} Gallery`) {
            extractedTitle = meta.title.slice(0, 160);
          } else if (typeof meta.description === 'string' && extractedTitle === `${platform} Gallery`) {
            extractedTitle = meta.description.slice(0, 60);
          }

          const ext = String(meta.extension || path.extname(new URL(directUrl).pathname).slice(1)).toLowerCase();
          if (!/^(jpg|jpeg|png|gif|webp|avif|tif|heic)$/.test(ext)) continue;
          const filename = sanitizeFilename((typeof meta.filename === 'string' ? meta.filename : '') || path.basename(new URL(directUrl).pathname) || `image_${images.length + 1}`);
          seen.add(directUrl);

          images.push({
            id: `img_${images.length + 1}`,
            url: directUrl,
            thumbnailUrl: directUrl,
            width: meta.width,
            height: meta.height,
            filename: filename.toLowerCase().endsWith('.' + ext) ? filename : filename + '.' + ext,
            extension: ext,
          });
          if (images.length >= 50) break;
        }
      }
    } catch {}
  }

  if (images.length === 0) {
    throw new Error(`No downloadable images found for this ${platform} link.`);
  }

  return {
    title: extractedTitle,
    thumbnail: images[0].thumbnailUrl || images[0].url,
    platform,
    url,
    totalImages: images.length,
    images,
  };
}

/**
 * Downloads multiple gallery images and packages them into a streaming ZIP archive.
 */
export async function downloadGalleryZip(
  images: GalleryItem[],
  zipFilePath: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  if (!images.length || images.length > 50) throw new Error('A gallery must contain 1 to 50 images.');
  const output = fs.createWriteStream(zipFilePath, { flags: 'wx' });
  const { ZipArchive } = require('archiver');
  const archive = new ZipArchive({ zlib: { level: 6 } });

  archive.on('error', (err: Error) => output.destroy(err));
  const written = finished(output);
  void written.catch(() => {});
  archive.pipe(output);
  const signal = AbortSignal.timeout(45_000);
  let saved = 0;
  let totalBytes = 0;
  try {
    for (let i = 0; i < images.length && !signal.aborted; i += 4) {
      const batch = await Promise.all(images.slice(i, i + 4).map(async (image) => {
        try {
          const response = await fetchCdnStream(image.url, { Accept: 'image/*', 'Accept-Encoding': 'identity' }, 5, { signal });
          const source = describeDirectSource(response.finalUrl, response.headers);
          if (response.statusCode !== 200 || source?.kind !== 'file' || source.category !== 'image') {
            response.stream.destroy();
            return null;
          }
          return { bytes: await readBounded(response.stream, 16 * 1024 * 1024), filename: sanitizeFilename(image.filename, source.filename) };
        } catch { return null; }
      }));
      batch.forEach((entry, index) => {
        if (!entry || !entry.bytes.length) return;
        totalBytes += entry.bytes.length;
        if (totalBytes > 128 * 1024 * 1024) throw new Error('Gallery exceeds the archive size limit.');
        archive.append(entry.bytes, { name: String(i + index + 1).padStart(3, '0') + '_' + entry.filename });
        saved++;
      });
      onProgress?.(Math.min(99, Math.round((i + batch.length) / images.length * 100)));
    }
    if (!saved) throw new Error('No public images could be downloaded.');
    await Promise.all([archive.finalize(), written]);
    onProgress?.(100);
    return zipFilePath;
  } catch (error) {
    archive.abort();
    output.destroy();
    await written.catch(() => {});
    throw error;
  }
}
