import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDirectSource, isLiveChannel, resolvePublicDocumentUrl } from '../services/source-discovery';
import { assertPublicUrl, isPrivateIp } from '../utils/sanitizer';
import { openEngineProxy } from '../services/engine-proxy';
import http from 'node:http';

test('recognizes extensionless downloads and preserves the original file name', () => {
  const source = describeDirectSource('https://example.com/download?id=8', {
    'content-type': 'application/pdf',
    'content-disposition': "attachment; filename=backup.pdf; filename*=UTF-8''Lecture%20Notes.pdf",
    'content-length': '8192',
  });
  assert.deepEqual(source, { kind: 'file', category: 'document', filename: 'Lecture Notes.pdf', extension: 'pdf', contentType: 'application/pdf', size: 8192 });
});

test('uses content type for manifests and rejects HTML and executables', () => {
  assert.equal(describeDirectSource('https://example.com/session', { 'content-type': 'application/dash+xml' })?.kind, 'dash');
  assert.equal(describeDirectSource('https://example.com/movie.mp4', { 'content-type': 'text/html' }), null);
  assert.equal(describeDirectSource('https://example.com/setup.exe', { 'content-type': 'application/octet-stream' }), null);
  assert.equal(describeDirectSource('https://example.com/live.m3u8', { 'content-type': 'text/plain' })?.kind, 'hls');
});

test('distinguishes live channel URLs from clips, VODs, and lookalike domains', () => {
  assert.equal(isLiveChannel('https://www.twitch.tv/somechannel'), true);
  assert.equal(isLiveChannel('https://kick.com/somechannel'), true);
  assert.equal(isLiveChannel('https://www.twitch.tv/videos/12345'), false);
  assert.equal(isLiveChannel('https://twitch.tv.example.com/somechannel'), false);
});

test('blocks local addresses, mapped IPv6, credentials and non-web ports', async () => {
  for (const address of ['[::ffff:7f00:1]', '224.0.0.1', '198.18.0.1', '192.0.2.1', 'fe90::1', 'ff02::1']) {
    assert.equal(isPrivateIp(address), true, address);
  }
  for (const url of ['http://[::ffff:7f00:1]/', 'http://user:pass@8.8.8.8/', 'http://8.8.8.8:22/']) {
    assert.equal((await assertPublicUrl(url)).isValid, false, url);
  }
});

test('resolves official paper and ebook landing pages to their public files', () => {
  assert.equal(resolvePublicDocumentUrl('https://arxiv.org/abs/1706.03762v7'), 'https://arxiv.org/pdf/1706.03762v7');
  assert.equal(resolvePublicDocumentUrl('https://www.gutenberg.org/ebooks/84'), 'https://www.gutenberg.org/ebooks/84.epub3.images');
  assert.equal(resolvePublicDocumentUrl('https://gutenberg.org.example.com/ebooks/84'), 'https://gutenberg.org.example.com/ebooks/84');
});

test('worker proxy rejects CONNECT tunnels to private addresses', async () => {
  const proxy = await openEngineProxy(AbortSignal.timeout(3000), 1024);
  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(proxy.url, { method: 'CONNECT', path: '127.0.0.1:443', signal: proxy.signal });
      req.once('error', reject);
      req.once('connect', (res, socket) => {
        socket.destroy();
        if (res.statusCode === 403) resolve();
        else reject(new Error('Proxy returned ' + res.statusCode));
      });
      req.end();
    });
  } finally { proxy.close(); }
});
