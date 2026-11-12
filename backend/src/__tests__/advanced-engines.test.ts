import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { selectAdvancedEngine } from '../services/advanced-input';
import { advancedRoute } from '../routes/advanced';
import { openEngineProxy } from '../services/engine-proxy';
import { libgenFileLink } from '../services/libgen-download';
import { selectSpotifyAudioMatch } from '../services/spotify-match';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('routes known links and identifiers without turning unknown links into crawls', () => {
  assert.equal(selectAdvancedEngine('https://open.spotify.com/intl-fr/track/3DaGnKmAAmyZGIbC0KjmxT').engine, 'spotdl');
  assert.deepEqual(selectAdvancedEngine('https://www.coursera.org/learn/machine-learning/lecture/abc'), {
    engine: 'coursera-dl', value: 'machine-learning',
  });
  assert.deepEqual(selectAdvancedEngine('https://doi.org/10.1000/example'), {
    engine: 'scihub', value: '10.1000/example',
  });
  assert.equal(selectAdvancedEngine('https://www.udemy.com/course/example/', 'curs-dl').engine, 'udemy-downloader');
  assert.throws(() => selectAdvancedEngine('https://example.com/'), /choose.*mirror/i);
});

test('restricts provider inputs, crawler protocols, and local library selection', () => {
  for (const [value, engine] of [
    ['https://coursera.org.example.com/learn/course', 'coursera-dl'],
    ['https://open.spotify.com@evil.example/track/0123456789012345678901', 'spotdl'],
    ['https://example.com:9000/', 'wget'],
    ['../../somewhere/private.m4b', 'openaudible'],
    ['--output=private', 'libgen'],
  ] as const) assert.throws(() => selectAdvancedEngine(value, engine), value);
  assert.equal(selectAdvancedEngine('B012345678', 'openaudible').value, 'B012345678');
});

test('LibGen selects a same-mirror file link for the requested hash only', () => {
  const hash = 'f11311126c895be5d85ca35493322be9';
  const page = 'https://libgen.li/ads.php?md5=' + hash;
  const invalid = [
    `<a href="https://example.com/get.php?md5=${hash}&key=abcde">Wrong host</a>`,
    '<a href="get.php?md5=00000000000000000000000000000000&key=abcde">Wrong book</a>',
    `<a href="get.php?md5=${hash}&md5=00000000000000000000000000000000&key=abcde">Duplicate hash</a>`,
  ].join('');
  assert.equal(libgenFileLink(invalid, page, hash), undefined);
  assert.equal(libgenFileLink(invalid + `<a href="get.php?md5=${hash}&amp;key=abcde">Book</a>`, page, hash),
    `https://libgen.li/get.php?md5=${hash}&key=abcde`);
});

test('Spotify fallback skips covers, wrong durations and unrelated artists', () => {
  const track = { title: 'Carefree', artist: 'Kevin MacLeod', durationSec: 205 };
  const cover = { id: 'aaaaaaaaaaa', title: 'Carefree (Kevin MacLeod cover)', duration: 205 };
  const short = { id: 'bbbbbbbbbbb', title: 'Carefree', uploader: 'Kevin MacLeod', duration: 31 };
  const other = { id: 'ccccccccccc', title: 'Carefree', uploader: 'Another Artist', duration: 205 };
  const exact = { id: 'sMcWOaJFuw0', title: 'Carefree', channel: 'Kevin MacLeod', duration: 206 };
  assert.equal(selectSpotifyAudioMatch(track, [cover, short, other]), undefined);
  assert.equal(selectSpotifyAudioMatch(track, [cover, short, other, exact]), exact);
});

test('advanced jobs require a dedicated operator key even when the public API is open', async () => {
  const app = Fastify();
  await app.register(advancedRoute, { prefix: '/advanced', key: () => 'a-long-local-key-that-only-the-owner-has' });
  try {
    const payload = { engine: 'wget', input: 'https://example.com/' };
    assert.equal((await app.inject({ method: 'POST', url: '/advanced/jobs', payload })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/advanced/engines', headers: { 'x-api-key': 'a-long-local-key-that-only-the-owner-has' } })).statusCode, 401);
    const result = await app.inject({ method: 'GET', url: '/advanced/engines', headers: { 'x-advanced-key': 'a-long-local-key-that-only-the-owner-has' } });
    assert.equal(result.statusCode, 200);
    assert.ok(result.json().engines.some((engine: { id: string }) => engine.id === 'openaudible'));
  } finally { await app.close(); }
});

test('mirror proxy rejects a second public host before opening a connection', async () => {
  const proxy = await openEngineProxy(AbortSignal.timeout(3000), 1024, { allowedHost: 'example.org' });
  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(proxy.url, { method: 'CONNECT', path: 'example.com:443', signal: proxy.signal });
      req.once('error', reject);
      req.once('connect', (res, socket) => {
        socket.destroy();
        if (res.statusCode === 403) resolve();
        else reject(new Error('Unexpected proxy status ' + res.statusCode));
      });
      req.end();
    });
  } finally { proxy.close(); }
});

test('serves an OpenAudible export through the authenticated job flow', async () => {
  const library = await fs.mkdtemp(path.join(os.tmpdir(), 'easysave-export-test-'));
  const prior = process.env.OPENAUDIBLE_EXPORT_DIR;
  const filename = 'Sample B012345678.wav';
  const audio = Buffer.alloc(52);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(44, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(8, 40);
  await fs.writeFile(path.join(library, filename), audio);
  process.env.OPENAUDIBLE_EXPORT_DIR = library;
  const app = Fastify();
  const key = 'a-long-local-key-that-only-the-owner-has';
  await app.register(advancedRoute, { prefix: '/advanced', key: () => key });
  const headers = { 'x-advanced-key': key };
  try {
    const submitted = await app.inject({ method: 'POST', url: '/advanced/jobs', headers,
      payload: { input: 'https://www.audible.com/pd/Sample/B012345678' } });
    assert.equal(submitted.statusCode, 202, submitted.body);
    const route = '/advanced/jobs/' + submitted.json().id;
    let status;
    for (let i = 0; i < 80; i++) {
      status = (await app.inject({ method: 'GET', url: route, headers })).json();
      if (['ready', 'error'].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status.status, 'ready', JSON.stringify(status));
    assert.equal(status.filename, filename);
    assert.equal((await app.inject({ method: 'GET', url: route + '/file' })).statusCode, 401);
    const file = await app.inject({ method: 'GET', url: route + '/file', headers });
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers['content-type'], 'audio/wav');
    assert.deepEqual(file.rawPayload, audio);
  } finally {
    await app.close();
    if (prior === undefined) delete process.env.OPENAUDIBLE_EXPORT_DIR;
    else process.env.OPENAUDIBLE_EXPORT_DIR = prior;
    await fs.unlink(path.join(library, filename));
    await fs.rmdir(library);
  }
});
