'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Download } from 'lucide-react';
import InfoPage from './InfoPage';
import SuccessCheck from './SuccessCheck';
import { saveFromUrl } from '@/lib/download-session';
import styles from './AdvancedConsole.module.css';

type Engine = { id: string; status: string; setup: string };
type Job = { id: string; engine: string; worker?: string; status: 'queued' | 'running' | 'packaging' | 'ready' | 'cancelled' | 'error'; filename?: string; bytes?: number; message?: string };

const labels: Record<string, string> = {
  ripme: 'Photo albums (RipMe)', wget: 'Website copy (Wget)', httrack: 'Website copy (HTTrack)', 'coursera-dl': 'Coursera courses',
  'udemy-downloader': 'Udemy courses', 'curs-dl': 'Course links',
  streamrip: 'Music links (streamrip)', openaudible: 'Audiobook exports (OpenAudible)', libgen: 'LibGen books',
  'annas-mcp': 'Anna’s Archive books', scihub: 'Research papers (Sci-Hub)', spotdl: 'Spotify links (SpotDL)',
};
const stateLabel: Record<Job['status'], string> = {
  queued: 'Waiting to start', running: 'Getting your file', packaging: 'Packing your files',
  ready: 'Ready to save', cancelled: 'Cancelled', error: 'Download failed',
};
const workerLabels: Record<string, string> = {
  'libgen-mirror': 'LibGen mirror',
  'yt-dlp (matched Spotify track)': 'Matched audio from YouTube',
};
const placeholders: Record<string, string> = {
  auto: 'Paste a link or DOI', wget: 'https://example.com/', httrack: 'https://example.com/',
  openaudible: 'Audiobook filename or Audible link', libgen: 'MD5 hash or book link',
  'annas-mcp': 'MD5 hash or archive link', scihub: 'DOI, PMID, or paper link',
};
const backend = process.env.NEXT_PUBLIC_BACKEND_URL || '';
const field = `${styles.field} w-full rounded-lg px-3.5 py-3 text-sm text-ink placeholder:text-muted`;
const isRunning = (job: Job | null) => !!job && ['queued', 'running', 'packaging'].includes(job.status);

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function errorMessage(cause: unknown) {
  return cause instanceof TypeError || (cause instanceof Error && cause.name === 'TimeoutError')
    ? 'Could not reach the download server. Try again.'
    : cause instanceof Error ? cause.message : 'Something went wrong. Try again.';
}

async function request(key: string, route: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-Advanced-Key', key);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(backend + '/api/advanced' + route, { ...init, headers, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new RequestError(response.status === 401 ? 'That access key didn’t work.' : body.message || 'Advanced tools are temporarily unavailable.', response.status);
  }
  return response;
}

export default function AdvancedConsole() {
  const [key, setKey] = useState('');
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [engine, setEngine] = useState('auto');
  const [input, setInput] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const sourceRef = useRef<HTMLInputElement>(null);
  const running = isRunning(job);
  const currentId = job?.id;
  const selection = engines?.find((item) => item.id === engine);
  const readyTools = engines?.filter((item) => ['available', 'alias'].includes(item.status)) || [];
  const setupTools = engines?.filter((item) => !readyTools.includes(item)) || [];

  useEffect(() => { if (engines) sourceRef.current?.focus(); }, [engines]);

  useEffect(() => {
    if (!running || !currentId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await request(key, '/jobs/' + currentId, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        const current: Job = await response.json();
        if (controller.signal.aborted) return;
        setPollError('');
        setJob((previous) => previous?.id === currentId && isRunning(previous) ? current : previous);
        if (isRunning(current)) timer = setTimeout(poll, 1500);
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause instanceof RequestError && [401, 404].includes(cause.status)) {
            setJob((previous) => previous?.id === currentId && isRunning(previous) ? { ...previous, status: 'error', message: cause.message } : previous);
            setPollError('');
          } else {
            setPollError('Waiting to reconnect…');
            timer = setTimeout(poll, 4000);
          }
        }
      }
    };
    timer = setTimeout(poll, 750);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [currentId, key, running]);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await request(key.trim(), '/engines', { signal: AbortSignal.timeout(8000) });
      const result = await response.json();
      setKey(key.trim());
      setEngines(result.engines);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setPollError('');
    setSaved(false);
    setJob(null);
    try {
      const response = await request(key, '/jobs', { method: 'POST', body: JSON.stringify({ input: input.trim(), engine }), signal: AbortSignal.timeout(12_000) });
      setJob(await response.json());
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!job) return;
    setBusy(true);
    try {
      await request(key, '/jobs/' + job.id, { method: 'DELETE', signal: AbortSignal.timeout(8000) });
      setJob({ ...job, status: 'cancelled' });
      setError('');
      setPollError('');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!job?.filename) return;
    setBusy(true);
    setError('');
    try {
      const response = await request(key, '/jobs/' + job.id + '/file');
      const url = URL.createObjectURL(await response.blob());
      saveFromUrl(url, job.filename);
      setSaved(true);
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return (
    <InfoPage title="Advanced tools" description="Save photo albums, copies of websites, books and more from supported sources.">
      <section className={`${styles.console} rounded-2xl border border-line bg-panel p-4 sm:p-6`} aria-label="Download tools">
        {engines ? (
          <form onSubmit={start} className="space-y-4">
            <div>
              <label htmlFor="advanced-source" className="download-field-label">Link or ID</label>
              <input ref={sourceRef} id="advanced-source" value={input} onChange={(e) => setInput(e.target.value)} placeholder={placeholders[engine] || 'Paste a supported link'}
                className={field} required maxLength={2048} disabled={running || busy} spellCheck={false} />
            </div>
            <div>
              <label htmlFor="advanced-engine" className="download-field-label">Download tool</label>
              <select id="advanced-engine" value={engine} onChange={(e) => setEngine(e.target.value)} className={field} disabled={running || busy}>
                <option value="auto">Choose for me</option>
                {readyTools.length > 0 && <optgroup label="Available tools">
                  {readyTools.map((item) => <option key={item.id} value={item.id}>{labels[item.id] || item.id}</option>)}
                </optgroup>}
                {setupTools.length > 0 && <optgroup label="May need setup">
                  {setupTools.map((item) => <option key={item.id} value={item.id}>{labels[item.id] || item.id}</option>)}
                </optgroup>}
              </select>
              {selection && selection.status !== 'available' ? <p className="mt-2 text-sm text-muted">{selection.setup}</p> : null}
            </div>
            <button className={job?.status === 'ready' ? 'btn-secondary justify-center' : 'btn-primary justify-center'} type="submit" disabled={busy || running}>
              <ArrowRight size={16} aria-hidden="true" /> {busy && !job ? 'Starting…' : 'Prepare download'}
            </button>
          </form>
        ) : (
          <form onSubmit={unlock} className="space-y-4">
            <div>
              <label htmlFor="advanced-key" className="download-field-label">DropSilo access key</label>
              <div className="flex gap-2">
                <input id="advanced-key" aria-describedby="key-hint" value={key} onChange={(e) => setKey(e.target.value)} type={showKey ? 'text' : 'password'} autoComplete="off"
                  className={field + ' min-w-0'} required minLength={32} maxLength={256} disabled={busy} />
                <button type="button" aria-controls="advanced-key" className="btn-secondary" onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'}</button>
              </div>
              <p id="key-hint" className="mt-2 text-sm text-muted">Enter the key from whoever runs this DropSilo server.</p>
            </div>
            <button className="btn-primary justify-center" type="submit" disabled={busy}>
              <ArrowRight size={16} aria-hidden="true" /> {busy ? 'Checking key…' : 'Unlock tools'}
            </button>
          </form>
        )}
        {job ? (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <div className="min-w-0" role="status" aria-live="polite">
              <p className={job.status === 'ready' ? 'flex items-center gap-2 text-sm font-semibold text-success' : 'text-sm font-semibold text-ink'}>
                {job.status === 'ready' && <SuccessCheck size={14} />}{saved ? 'Check your browser’s downloads' : pollError || stateLabel[job.status]}
              </p>
              <p className="mt-0.5 break-words text-xs text-muted">{job.message || job.filename || labels[job.engine]}</p>
              {job.worker && workerLabels[job.worker] ? <p className="mt-1 text-xs text-muted">Source used · {workerLabels[job.worker]}</p> : null}
              {job.bytes ? <p className="mt-1 text-xs tabular-nums text-muted">{(job.bytes / (job.bytes >= 1048576 ? 1048576 : 1024)).toFixed(1)} {job.bytes >= 1048576 ? 'MB' : 'KB'}</p> : null}
            </div>
            {running ? <button type="button" className="btn-secondary" disabled={busy} onClick={cancel}>Cancel</button> : null}
            {job.status === 'ready' ? (
              <button type="button" className="btn-primary" disabled={busy} onClick={save}>
                <Download size={16} aria-hidden="true" /> {busy ? 'Saving…' : 'Save file'}
              </button>
            ) : null}
          </div>
        ) : null}
        {error ? <p role="alert" className="media-download-error mt-4 rounded-lg px-3 py-2 text-sm">{error}</p> : null}
      </section>
      <p className="mt-5 text-sm text-muted">For a public video, song or direct file, use the <Link href="/" className="text-accent underline underline-offset-2">main downloader</Link>.</p>
    </InfoPage>
  );
}
