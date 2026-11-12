import fs from 'node:fs';
import path from 'node:path';
import { rootCertificates } from 'node:tls';
import { CONFIG } from '../config';
import { assertPublicUrl } from '../utils/sanitizer';
import { openEngineProxy } from './engine-proxy';
import { exec } from './source-engines';
import { getFfmpegPath, getYtDlpPath } from './ytdl.service';
import { ADVANCED_ENGINES, type EngineSelection } from './advanced-input';
import { downloadLibgenBook } from './libgen-download';
import { downloadMatchedSpotifyTrack } from './spotify-match';

type ActualEngine = EngineSelection['engine'];
const windows = process.platform === 'win32';
const base = path.join(process.cwd(), 'bin', 'advanced');
const exe = (name: string) => name + (windows ? '.exe' : '');
const venv = (name: string, command: string) => path.join(process.cwd(), 'bin', name, windows ? 'Scripts' : 'bin', exe(command));

function file(envName: string, ...defaults: string[]): string | undefined {
  const setting = process.env[envName];
  for (const candidate of setting ? [setting] : defaults) {
    try { if (fs.statSync(candidate).isFile()) return path.resolve(candidate); } catch {}
  }
}

function command(envName: string, name: string, ...defaults: string[]): string | undefined {
  return file(envName, ...defaults, ...((process.env.PATH || '').split(path.delimiter).filter(Boolean).map((p) => path.join(p, exe(name)))));
}

function firstInside(root: string, name: string): string | undefined {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const found = path.join(root, entry.name, name);
        if (fs.existsSync(found)) return found;
      }
    }
  } catch {}
}

function audiobookRoot(): string | undefined {
  const configured = process.env.OPENAUDIBLE_EXPORT_DIR;
  try { if (configured && fs.statSync(configured).isDirectory()) return fs.realpathSync.native(configured); } catch {}
}

function engineResources(engine: ActualEngine) {
  switch (engine) {
    case 'ripme':
      return { binary: command('RIPME_JAVA_PATH', 'java'), asset: file('RIPME_JAR_PATH', path.join(base, 'ripme.jar')),
        setup: 'Install Java and configure RIPME_JAR_PATH.' };
    case 'wget':
      return { binary: command('WGET_PATH', 'wget', path.join(base, exe('wget'))), setup: 'Install GNU Wget or set WGET_PATH.' };
    case 'httrack':
      return { binary: command('HTTRACK_PATH', 'httrack', path.join(base, exe('httrack')), path.join(base, 'httrack', 'httrack', exe('httrack'))),
        setup: 'Install the HTTrack CLI or set HTTRACK_PATH.' };
    case 'coursera-dl':
      return { binary: file('COURSE_PYTHON_PATH', venv('advanced-python', 'python')),
        asset: file('COURSES_CLI_BRIDGE_PATH', path.join(process.cwd(), 'scripts', 'course-cli.py')),
        credential: file('COURSERA_CAUTH_FILE'), setup: 'Install coursera-dl and set COURSERA_CAUTH_FILE.' };
    case 'udemy-downloader':
      return { binary: file('COURSE_PYTHON_PATH', venv('advanced-python', 'python')),
        asset: file('COURSES_CLI_BRIDGE_PATH', path.join(process.cwd(), 'scripts', 'course-cli.py')),
        credential: file('UDEMY_BEARER_FILE'), setup: 'Install the Udemy CLI and set UDEMY_BEARER_FILE.' };
    case 'streamrip':
      return { binary: command('STREAMRIP_PATH', 'rip', venv('streamrip-python', 'rip')),
        credential: file('STREAMRIP_CONFIG_PATH'), setup: 'Install streamrip; paid services need STREAMRIP_CONFIG_PATH.' };
    case 'openaudible':
      return { library: audiobookRoot(), setup: 'Export books in OpenAudible and set OPENAUDIBLE_EXPORT_DIR.' };
    case 'libgen':
      return { setup: 'Built-in LibGen mirror downloader. Supply a book link or MD5 hash.' };
    case 'annas-mcp':
      return { binary: command('ANNAS_CLI_PATH', 'annas-mcp', path.join(base, exe('annas-mcp')),
        firstInside(path.join(base, 'anna'), exe('annas-mcp')) || ''),
        credential: file('ANNAS_SECRET_KEY_FILE'), setup: 'Install annas-mcp and set ANNAS_SECRET_KEY_FILE.' };
    case 'scihub': {
      const source = firstInside(path.join(base, 'scihub'), path.join('scihub', 'scihub.py'));
      return { binary: file('SCIHUB_PYTHON_PATH', venv('advanced-python', 'python')), asset: file('SCIHUB_SCRIPT_PATH', source || ''),
        bridge: file('SCIHUB_CLI_BRIDGE_PATH', path.join(process.cwd(), 'scripts', 'scihub-cli.py')),
        mirror: sciHubMirror(), setup: 'Install scihub.py and set SCIHUB_BASE_URL to the mirror to use.' };
    }
    case 'spotdl':
      return { binary: command('SPOTDL_PATH', 'spotdl', path.join(base, exe('spotdl'))), setup: 'Install spotDL or set SPOTDL_PATH.' };
  }
}

function sciHubMirror() {
  try {
    const url = new URL(process.env.SCIHUB_BASE_URL || '');
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch {}
}

const isPublicMusic = (value: string) => {
  const host = new URL(value).hostname;
  return ['soundcloud.com', 'bandcamp.com'].some((name) => host === name || host.endsWith('.' + name));
};

function isPublicTrack(value: string) {
  const { hostname, pathname } = new URL(value);
  if (hostname === 'soundcloud.com' || hostname === 'www.soundcloud.com') return /^\/[^/]+\/[^/]+\/?$/.test(pathname);
  return hostname.endsWith('.bandcamp.com') && /^\/track\/[^/]+\/?$/.test(pathname);
}

async function hasAudioOutput(output: string) {
  const files = await fs.promises.readdir(output, { recursive: true, withFileTypes: true });
  return files.some((file) => file.isFile() && audioExtension.test(file.name));
}

async function runWindowsSpotdl(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, timeout: number) {
  signal.throwIfAborted();
  // The Windows build launches another copy that keeps stdout open if only the parent is killed.
  const command = exec(executable, args, { cwd, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const stop = () => {
    const child = command.child;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const taskkill = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
    void exec(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 })
      .catch(() => child.kill());
  };
  const timer = setTimeout(stop, timeout);
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) stop();
    await command;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

function installed(engine: ActualEngine, resources: ReturnType<typeof engineResources>) {
  if (engine === 'libgen') return true;
  if (engine === 'openaudible') return !!resources.library;
  if (engine === 'scihub') return !!resources.binary && !!resources.asset && !!resources.bridge && !!resources.mirror;
  return !!resources.binary && (!['ripme', 'coursera-dl', 'udemy-downloader', 'scihub'].includes(engine) || !!resources.asset);
}

function needsCredential(engine: ActualEngine, value?: string) {
  return ['coursera-dl', 'udemy-downloader', 'annas-mcp'].includes(engine)
    || (engine === 'streamrip' && !!value && !isPublicMusic(value));
}

export function listAdvancedEngines() {
  return ADVANCED_ENGINES.map((id) => {
    if (id === 'curs-dl') return { id, status: 'alias', setup: 'Routes Coursera and Udemy links to their installed CLI.' };
    const resources = engineResources(id);
    return { id, status: !installed(id, resources) ? 'setup-required' :
      needsCredential(id) && !resources.credential ? 'account-required' : 'available', setup: resources.setup };
  });
}

export function engineReadiness(selection: EngineSelection): string | undefined {
  const resources = engineResources(selection.engine);
  if (!installed(selection.engine, resources) || needsCredential(selection.engine, selection.value) && !resources.credential) {
    return resources.setup;
  }
}

function subprocessEnv(proxy: string) {
  const env: NodeJS.ProcessEnv = {};
  const allowed = /^(path|pathext|systemroot|windir|systemdrive|comspec|home|userprofile|homedrive|homepath|appdata|localappdata|programdata|temp|tmp|lang|lc_all|ssl_cert_file|ssl_cert_dir)$/i;
  for (const [key, value] of Object.entries(process.env)) if (allowed.test(key)) env[key] = value;
  return { ...env, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, no_proxy: '',
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: '', PYTHONUTF8: '1' };
}

async function readCredential(filename: string): Promise<string> {
  if ((await fs.promises.stat(filename)).size > 16_384) throw new Error('Invalid provider credential file.');
  const value = (await fs.promises.readFile(filename, 'utf8')).trim();
  if (!value || /[\x00-\x20\x7f]/.test(value)) throw new Error('Invalid provider credential file.');
  return value;
}

export const ADVANCED_MAX_BYTES = Math.min(CONFIG.DIRECT_DOWNLOAD_MAX_BYTES, 512 * 1024 * 1024);

export async function invokeAdvancedEngine(selection: EngineSelection, work: string, output: string, signal: AbortSignal) {
  const { engine, value } = selection;
  if (engine === 'libgen') {
    await downloadLibgenBook(value, output, ADVANCED_MAX_BYTES, signal);
    return 'libgen-mirror';
  }
  const resources = engineResources(engine);
  if (engine === 'openaudible') {
    await copyAudiobook(resources.library!, value, output);
    return 'openaudible';
  }
  if (value.startsWith('https://') || value.startsWith('http://')) {
    const check = await assertPublicUrl(value);
    if (!check.isValid) throw new Error('The source does not resolve to a public web address.');
  }
  const isMirror = engine === 'wget' || engine === 'httrack';
  const spotTrack = engine === 'spotdl' && new URL(value).pathname.startsWith('/track/');
  const proxy = await openEngineProxy(signal, isMirror ? 32 * 1024 * 1024 : ADVANCED_MAX_BYTES,
    isMirror ? { allowedHost: new URL(value).hostname } : {});
  try {
    const env: NodeJS.ProcessEnv = subprocessEnv(proxy.url);
    const proxyHost = new URL(proxy.url).host;
    let executable = resources.binary!;
    let args: string[];
    switch (engine) {
      case 'ripme':
        args = ['-jar', resources.asset!, '--no-prop-file', '--history', path.join(work, 'history.txt'),
          '--proxy-server', proxyHost, '--threads', '2', '--ripsdirectory', output, '--url', value];
        break;
      case 'wget': {
        const ca = path.join(work, 'ca.pem');
        await fs.promises.writeFile(ca, rootCertificates.join('\n') + '\n', { flag: 'wx' });
        args = ['--no-config', '--no-cookies', '--recursive', '--level=2', '--no-parent', '--convert-links',
          '--adjust-extension', '--page-requisites', '--no-verbose', '--timeout=12', '--tries=1',
          '--wait=1', '--limit-rate=500k', '--quota=30m', '--max-redirect=5',
          '--ca-certificate=' + ca, '--domains=' + new URL(value).hostname, '--directory-prefix=' + output, '--', value];
        break;
      }
      case 'httrack':
        args = [value, '--path', output, '--proxy', 'connect://' + proxyHost, '--stay-on-same-address',
          '--depth=3', '--sockets=2', '--robots=2', '--max-size=30000000', '--max-time=75', '--quiet'];
        break;
      case 'coursera-dl': case 'udemy-downloader':
        env.EASYSAVE_PROVIDER_CREDENTIAL_FILE = resources.credential!;
        args = [resources.asset!, engine, value, output];
        break;
      case 'streamrip': {
        const config = path.join(work, 'streamrip.toml');
        if (resources.credential) await fs.promises.copyFile(resources.credential, config, fs.constants.COPYFILE_EXCL);
        args = ['--config-path', config, '--folder', output, '--no-db', '--no-progress', 'url', value];
        const host = new URL(value).hostname;
        if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
          const python = file('STREAMRIP_PYTHON_PATH', path.join(path.dirname(executable), exe('python')));
          const script = path.join(process.cwd(), 'scripts', 'streamrip-soundcloud.py');
          if (python && fs.existsSync(script)) {
            executable = python;
            env.EASYSAVE_STREAMRIP_FFMPEG = getFfmpegPath();
            args.unshift(script);
          }
        }
        break;
      }
      case 'annas-mcp':
        env.ANNAS_SECRET_KEY = await readCredential(resources.credential!);
        env.ANNAS_DOWNLOAD_PATH = output;
        args = ['--timeout', '4m', 'book-download', value];
        break;
      case 'scihub':
        args = [resources.bridge!, resources.asset!, resources.mirror!, value, output];
        break;
      case 'spotdl':
        args = ['download', value, '--proxy', proxy.url, '--ffmpeg', getFfmpegPath(), '--format', 'mp3', '--threads', '1', '--restrict',
          'strict', '--output', path.join(output, '{artists} - {title}.{output-ext}')];
        break;
    }
    try {
      const timeout = isMirror ? 100_000 : spotTrack ? 50_000 : 6 * 60 * 1000;
      if (windows && engine === 'spotdl') await runWindowsSpotdl(executable, args, work, env, proxy.signal, timeout);
      else await exec(executable, args, { cwd: work, env, signal: proxy.signal, maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout });
      if ((spotTrack || (engine === 'streamrip' && isPublicTrack(value))) && !await hasAudioOutput(output)) {
        throw new Error(`${engine} produced no audio file.`);
      }
    } catch {
      if (proxy.signal.aborted) throw new Error('The job was stopped or exceeded its transfer limit.');
      if (spotTrack && !await hasAudioOutput(output)) {
        try {
          await downloadMatchedSpotifyTrack(value, work, output, proxy.url, proxy.signal);
          return 'yt-dlp (matched Spotify track)';
        } catch {
          if (proxy.signal.aborted) throw new Error('The job was stopped or exceeded its transfer limit.');
          throw new Error('SpotDL did not finish, and DropSilo could not download a public audio match for this track.');
        }
      }
      if (engine === 'streamrip' && isPublicTrack(value)) {
        try {
          await exec(getYtDlpPath(), ['--no-config', '--no-playlist', '--no-exec', '--proxy', proxy.url,
            '--ffmpeg-location', getFfmpegPath(), '--socket-timeout', '15', '--retries', '1',
            '-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--add-metadata',
            '-o', path.join(output, '%(title).150B.%(ext)s'), '--', value],
          { cwd: work, env, signal: proxy.signal, maxBuffer: 4 * 1024 * 1024, timeout: 90_000, windowsHide: true });
          return 'yt-dlp';
        } catch {
          if (proxy.signal.aborted) throw new Error('The job was stopped or exceeded its transfer limit.');
        }
      }
      throw new Error(`${engine} could not download this source. Check provider access and try again.`);
    }
    return engine;
  } finally { proxy.close(); }
}

const audioExtension = /\.(mp3|m4a|m4b|aac|flac|opus|ogg|wav)$/i;
async function copyAudiobook(root: string, selected: string, output: string) {
  const pending = [{ dir: root, depth: 0 }];
  const candidates: string[] = [];
  const target = selected.toLowerCase();
  let seen = 0;
  while (pending.length) {
    const { dir, depth } = pending.pop()!;
    for await (const entry of await fs.promises.opendir(dir)) {
      if (++seen > 10_000) throw new Error('Choose a smaller OpenAudible export directory.');
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink() && depth < 6) pending.push({ dir: candidate, depth: depth + 1 });
      if (!entry.isFile() || !audioExtension.test(entry.name)) continue;
      const basename = entry.name.toLowerCase();
      if (basename === target || (/^[a-z0-9]{10}$/.test(target) && basename.split(/[^a-z0-9]/).includes(target))) {
        candidates.push(candidate);
      }
    }
  }
  if (candidates.length !== 1) throw new Error('Use the exact filename of one exported MP3 or M4B from OpenAudible.');
  const source = await fs.promises.realpath(candidates[0]);
  const relative = path.relative(root, source);
  if (relative.startsWith('..') || path.isAbsolute(relative) || (await fs.promises.stat(source)).size > ADVANCED_MAX_BYTES) {
    throw new Error('This audiobook export cannot be served from the configured library.');
  }
  await fs.promises.copyFile(source, path.join(output, path.basename(source)), fs.constants.COPYFILE_EXCL);
}
