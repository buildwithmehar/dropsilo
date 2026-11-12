import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CONFIG } from '../config';
import { openEngineProxy } from './engine-proxy';
import { isLiveChannel } from './source-discovery';

export const exec = promisify(execFile);

export function enginePath(name: string, envName: string, subfolder?: string): string | undefined {
  const exe = name + (process.platform === 'win32' ? '.exe' : '');
  const local = path.join(process.cwd(), 'bin');
  return [
    process.env[envName],
    path.join(local, exe),
    ...(subfolder ? [path.join(local, subfolder, exe)] : []),
    path.join('/usr/local/bin', exe),
    path.join('/usr/bin', exe),
  ].find((candidate): candidate is string => !!candidate && fs.existsSync(candidate));
}

export const getNMediaPath = () => enginePath('N_m3u8DL-RE', 'NM3U8DL_RE_PATH', 'nm3u8dl');
export const getStreamlinkPath = () => enginePath('streamlink', 'STREAMLINK_PATH', process.platform === 'win32' ? 'python-engines/Scripts' : 'python-engines/bin');
export const getGalleryEnginePath = () => enginePath('gallery-dl', 'GALLERY_DL_PATH', process.platform === 'win32' ? 'python-engines/Scripts' : 'python-engines/bin');

export class LiveSourceProbeError extends Error {}

export async function describeLiveSource(url: string, signal?: AbortSignal) {
  const command = getStreamlinkPath();
  if (!command || !isLiveChannel(url)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(12_000);
    const proxy = await openEngineProxy(signal ? AbortSignal.any([signal, timeout]) : timeout, 12 * 1024 * 1024);
    try {
      const { stdout } = await exec(command, [
        '--config', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '--http-proxy', proxy.url, '--http-timeout', '6', '--json', '--', url,
      ], { signal: proxy.signal, maxBuffer: 512 * 1024, windowsHide: true });
      const data = JSON.parse(stdout) as { streams?: Record<string, unknown>; metadata?: { title?: string }; error?: string };
      if (typeof data.error === 'string' && /no playable streams|channel is offline/i.test(data.error)) return null;
      if (!data.streams) continue;
      if (!Object.keys(data.streams).length) return null;
      const parsed = new URL(url);
      const channel = parsed.pathname.split('/')[1];
      return {
        title: typeof data.metadata?.title === 'string' && data.metadata.title.trim()
          ? data.metadata.title.slice(0, 160) : channel + ' live stream',
        filename: channel + '.mp4',
        platform: parsed.hostname.endsWith('kick.com') ? 'Kick' : 'Twitch',
      };
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      if (!proxy.signal.aborted && /no playable streams|channel is offline/i.test((output.stdout || '') + (output.stderr || ''))) return null;
    } finally { proxy.close(); }
  }
  throw new LiveSourceProbeError('The streaming provider did not respond. Try the live link again.');
}

export function liveRecordClock(): string {
  const seconds = CONFIG.LIVE_RECORD_SECONDS;
  return '00:' + String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
