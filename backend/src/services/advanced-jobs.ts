import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { CONFIG } from '../config';
import { isPathInsideDir, sanitizeFilename } from '../utils/sanitizer';
import { ADVANCED_MAX_BYTES, invokeAdvancedEngine } from './advanced-engines';
import type { EngineSelection } from './advanced-input';

type Status = 'queued' | 'running' | 'packaging' | 'ready' | 'error' | 'cancelled';
type Artifact = { path: string; filename: string; mime: string; bytes: number };
type Job = { id: string; selection: EngineSelection; status: Status; updatedAt: number;
  controller: AbortController; artifact?: Artifact; directory?: string; error?: string; worker?: string };

const RUNNING_LIMIT = 2;
const JOB_LIMIT = 12;
const RETAINED_LIMIT = 24;
const TTL = CONFIG.FILE_TOKEN_TTL_MS;
const MAX_FILES = 2_000;
const audio: Record<string, string> = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac' };
const documents: Record<string, string> = { '.pdf': 'application/pdf', '.epub': 'application/epub+zip',
  '.mobi': 'application/x-mobipocket-ebook', '.azw3': 'application/vnd.amazon.ebook', '.djvu': 'image/vnd.djvu',
  '.txt': 'text/plain', '.fb2': 'application/octet-stream' };
const media = /\.(jpg|jpeg|png|webp|gif|avif|bmp|mp4|webm|mkv|mov|mp3|flac|wav|m4a|ogg|aac)$/i;
const site = /\.(html?|xhtml|css|js|mjs|json|xml|jpg|jpeg|png|webp|gif|avif|bmp|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|pdf|txt)$/i;
const course = /\.(mp4|mkv|webm|mov|mp3|m4a|pdf|vtt|srt|txt|docx?|pptx?|xlsx?|png|jpe?g|webp|zip)$/i;

function includeFile(name: string, engine: EngineSelection['engine']) {
  const extension = path.extname(name).toLowerCase();
  switch (engine) {
    case 'wget': case 'httrack': return site.test(name) && !/^hts-(?:log|err)\.txt$/i.test(name);
    case 'ripme': return media.test(name);
    case 'udemy-downloader': case 'coursera-dl': return course.test(name);
    case 'libgen': case 'annas-mcp': case 'scihub': return Object.hasOwn(documents, extension);
    default: return Object.hasOwn(audio, extension);
  }
}

async function scan(root: string, signal: AbortSignal, engine?: EngineSelection['engine']) {
  const pending = [root];
  const entries: Array<{ path: string; name: string; size: number }> = [];
  let bytes = 0;
  let count = 0;
  while (pending.length) {
    const dir = pending.pop()!;
    for await (const entry of await fs.promises.opendir(dir)) {
      signal.throwIfAborted();
      if (++count > MAX_FILES) throw new Error('The source exceeded the file-count limit.');
      if (entry.isSymbolicLink()) continue;
      if (engine && (entry.name.startsWith('.') || /^hts-cache$/i.test(entry.name))) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { pending.push(absolute); continue; }
      if (!entry.isFile()) continue;
      const stat = await fs.promises.lstat(absolute).catch(() => null);
      if (!stat?.isFile()) continue;
      bytes += stat.size;
      if (bytes > ADVANCED_MAX_BYTES) throw new Error('The job exceeded the storage limit.');
      if (!engine || !stat.size || !includeFile(entry.name, engine)) continue;
      const name = path.relative(root, absolute).split(path.sep).map((segment) => sanitizeFilename(segment, 'file')).join('/');
      entries.push({ path: absolute, name, size: stat.size });
    }
  }
  return entries;
}

async function validDocument(file: string, extension: string) {
  if (extension !== '.pdf' && extension !== '.epub') return true;
  const fd = await fs.promises.open(file, 'r');
  try {
    const header = Buffer.alloc(8);
    await fd.read(header, 0, header.length, 0);
    return extension === '.pdf' ? header.subarray(0, 5).toString('ascii') === '%PDF-'
      : header.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
  } finally { await fd.close(); }
}

async function packageFiles(job: Job, work: string, output: string): Promise<Artifact> {
  const signal = job.controller.signal;
  const engine = job.selection.engine;
  const outputRoot = await fs.promises.realpath(output);
  const candidates = await scan(output, signal, engine);
  const files = [];
  for (const file of candidates) {
    if (await validDocument(file.path, path.extname(file.name).toLowerCase())) files.push(file);
  }
  if (!files.length) throw new Error('The engine did not produce a downloadable file.');
  const alwaysZip = ['ripme', 'wget', 'httrack', 'udemy-downloader', 'coursera-dl'].includes(engine);
  if (files.length === 1 && !alwaysZip) {
    const file = files[0];
    const ext = path.extname(file.name).toLowerCase();
    const actual = await fs.promises.realpath(file.path);
    if (!isPathInsideDir(outputRoot, actual)) throw new Error('The worker output path is invalid.');
    const destination = path.join(work, 'result' + ext);
    await fs.promises.rename(actual, destination);
    return { path: destination, filename: path.posix.basename(file.name), mime: audio[ext] || documents[ext] || 'application/octet-stream', bytes: file.size };
  }
  const zipFile = path.join(work, 'result.zip');
  const { ZipArchive } = require('archiver');
  const archive = new ZipArchive({ zlib: { level: 3 } });
  const out = fs.createWriteStream(zipFile, { flags: 'wx' });
  const completed = finished(out);
  void completed.catch(() => {});
  const cancel = () => { archive.abort(); out.destroy(new Error('Archive cancelled.')); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    archive.on('error', (error: Error) => out.destroy(error));
    archive.pipe(out);
    const names = new Set<string>();
    for (const file of files) {
      const actual = await fs.promises.realpath(file.path);
      if (!isPathInsideDir(outputRoot, actual)) continue;
      let name = file.name;
      for (let i = 2; names.has(name.toLowerCase()); i++) name = i + '-' + file.name.replace(/\//g, '_');
      names.add(name.toLowerCase());
      archive.file(actual, { name });
    }
    await Promise.all([archive.finalize(), completed]);
    signal.throwIfAborted();
    return { path: zipFile, filename: engine + '.zip', mime: 'application/zip', bytes: (await fs.promises.stat(zipFile)).size };
  } finally { signal.removeEventListener('abort', cancel); }
}

async function removeDirectory(dir: string) {
  if (path.dirname(dir) === CONFIG.TEMP_DIR && /^advanced-[\da-f-]+$/i.test(path.basename(dir))) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export class AdvancedJobs {
  private jobs = new Map<string, Job>();
  private running = new Set<Promise<void>>();
  private closing = false;
  private timer = setInterval(() => void this.sweep(), 60_000);

  constructor() { this.timer.unref(); }

  submit(selection: EngineSelection) {
    if (this.closing || this.jobs.size >= RETAINED_LIMIT ||
      [...this.jobs.values()].filter((job) => ['queued', 'running', 'packaging'].includes(job.status)).length >= JOB_LIMIT) return;
    const id = randomUUID();
    const job: Job = { id, selection, status: 'queued', updatedAt: Date.now(), controller: new AbortController() };
    this.jobs.set(id, job);
    this.drain();
    return this.summary(id);
  }

  summary(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    return { id, engine: job.selection.engine, worker: job.worker, status: job.status, message: job.error,
      filename: job.artifact?.filename, bytes: job.artifact?.bytes };
  }

  artifact(id: string) {
    const job = this.jobs.get(id);
    if (job?.status === 'ready' && Date.now() - job.updatedAt < TTL) return job.artifact;
  }

  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job || !['queued', 'running', 'packaging'].includes(job.status)) return false;
    job.controller.abort();
    job.status = 'cancelled';
    job.updatedAt = Date.now();
    return true;
  }

  async close() {
    this.closing = true;
    clearInterval(this.timer);
    for (const id of this.jobs.keys()) this.cancel(id);
    await Promise.allSettled([...this.running]);
    await Promise.all([...this.jobs.values()].flatMap((job) => job.directory ? [removeDirectory(job.directory)] : []));
    this.jobs.clear();
  }

  private async sweep() {
    for (const [id, job] of this.jobs) {
      if (['ready', 'error', 'cancelled'].includes(job.status) && Date.now() - job.updatedAt >= TTL) {
        if (job.directory) await removeDirectory(job.directory);
        this.jobs.delete(id);
      }
    }
  }

  private drain() {
    while (!this.closing && this.running.size < RUNNING_LIMIT) {
      const job = [...this.jobs.values()].find((item) => item.status === 'queued');
      if (!job) return;
      const execution = this.run(job);
      this.running.add(execution);
      void execution.finally(() => { this.running.delete(execution); this.drain(); });
    }
  }

  private async run(job: Job) {
    job.status = 'running';
    let monitor: NodeJS.Timeout | undefined;
    const sizeLimit = new AbortController();
    try {
      const work = path.join(CONFIG.TEMP_DIR, 'advanced-' + job.id);
      await fs.promises.mkdir(CONFIG.TEMP_DIR, { recursive: true });
      await fs.promises.mkdir(work, { mode: 0o700 });
      job.directory = work;
      const task = path.join(work, 'task');
      const output = path.join(task, 'files');
      await fs.promises.mkdir(output, { mode: 0o700, recursive: true });
      const signal = AbortSignal.any([job.controller.signal, sizeLimit.signal]);
      let checking = false;
      monitor = setInterval(() => {
        if (checking || signal.aborted) return;
        checking = true;
        void scan(work, signal).catch((error: unknown) => {
          if (!signal.aborted && error instanceof Error && /exceeded/.test(error.message)) sizeLimit.abort(error);
        }).finally(() => { checking = false; });
      }, 1_000);
      monitor.unref();
      job.worker = await invokeAdvancedEngine(job.selection, task, output, signal);
      signal.throwIfAborted();
      clearInterval(monitor);
      job.status = 'packaging';
      job.artifact = await packageFiles(job, work, output);
      if (path.dirname(task) === work && isPathInsideDir(work, task)) {
        await fs.promises.rm(task, { recursive: true, force: true });
      }
      signal.throwIfAborted();
      job.status = 'ready';
    } catch (error) {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'error';
      // The worker adapter maps third-party errors before they reach here.
      const message = error instanceof Error && !('code' in error) ? error.message : 'The advanced job could not finish.';
      if (job.status === 'error') job.error = sizeLimit.signal.aborted ? 'The job exceeded its storage limit.' : message;
      if (job.directory) await removeDirectory(job.directory);
    } finally {
      if (monitor) clearInterval(monitor);
      job.updatedAt = Date.now();
    }
  }
}
