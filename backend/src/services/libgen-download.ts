import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sanitizeFilename } from '../utils/sanitizer';
import { fetchCdnStream } from './proxy.service';
import { describeDirectSource } from './source-discovery';

const mirrors = ['https://libgen.li', 'https://libgen.gl'];
const bookExtension = /\.(pdf|epub|mobi|azw3|djvu|txt|fb2)$/i;
const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  'Accept-Encoding': 'identity',
};

export function libgenFileLink(html: string, page: string, md5: string): string | undefined {
  const origin = new URL(page).origin;
  if (!mirrors.includes(origin)) return;
  for (const match of html.matchAll(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    try {
      const url = new URL((match[1] || match[2] || match[3]).replace(/&(?:amp|#38);/gi, '&'), page);
      if (url.origin === origin && !url.username && !url.password && url.pathname === '/get.php' &&
          url.searchParams.getAll('md5').length === 1 && url.searchParams.get('md5')?.toLowerCase() === md5 &&
          /^[A-Za-z0-9_-]{4,100}$/.test(url.searchParams.get('key') || '')) {
        url.hash = '';
        return url.href;
      }
    } catch {}
  }
}

async function readMirrorPage(url: string, signal: AbortSignal) {
  const response = await fetchCdnStream(url, { ...browserHeaders, Accept: 'text/html' }, 3, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  try {
    if (response.statusCode !== 200) throw new Error('The LibGen mirror is unavailable.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.stream) {
      size += chunk.length;
      if (size > 512 * 1024) throw new Error('The LibGen page is too large.');
      chunks.push(chunk);
    }
    return libgenFileLink(Buffer.concat(chunks).toString('utf8'), response.finalUrl, new URL(url).searchParams.get('md5')!);
  } finally { response.stream.destroy(); }
}

export async function downloadLibgenBook(md5: string, output: string, limit: number, signal: AbortSignal) {
  if (!/^[a-f0-9]{32}$/.test(md5)) throw new Error('Invalid LibGen file hash.');
  for (const mirror of mirrors) {
    signal.throwIfAborted();
    const page = mirror + '/ads.php?md5=' + md5;
    let partial: string | undefined;
    try {
      const link = await readMirrorPage(page, signal);
      if (!link) continue;
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(75_000)]);
      const response = await fetchCdnStream(link, { ...browserHeaders, Referer: page }, 4, { signal: attempt });
      try {
        const mime = response.headers['content-type']?.toLowerCase() || '';
        const source = describeDirectSource(response.finalUrl, response.headers);
        const disposition = response.headers['content-disposition'] || '';
        const quoted = /(?:^|;)\s*filename="([^"]+)"/i.exec(disposition)?.[1];
        const fileName = quoted && bookExtension.test(quoted) ? sanitizeFilename(quoted, md5)
          : source?.kind === 'file' && bookExtension.test(source.filename) ? source.filename : undefined;
        if (response.statusCode !== 200 || /^(?:text\/html|application\/xhtml)/.test(mime) || !fileName) continue;
        if (source?.kind === 'file' && source.size && source.size > limit) throw new Error('LibGen file is too large.');
        partial = path.join(output, randomUUID() + '.part');
        let size = 0;
        const checksum = createHash('md5');
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            size += chunk.length;
            if (size > limit) return done(new Error('LibGen file is too large.'));
            checksum.update(chunk);
            done(null, chunk);
          },
        });
        await pipeline(response.stream, meter, fs.createWriteStream(partial, { flags: 'wx' }), { signal: attempt });
        if (size > 0 && checksum.digest('hex') === md5) {
          await fs.promises.rename(partial, path.join(output, fileName));
          return;
        }
      } finally { response.stream.destroy(); }
    } catch {
      signal.throwIfAborted();
    } finally {
      if (partial) await fs.promises.unlink(partial).catch(() => {});
    }
  }
  throw new Error('LibGen mirrors did not return a file matching the requested hash.');
}
