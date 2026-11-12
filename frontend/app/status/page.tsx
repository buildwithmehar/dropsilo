'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, RefreshCw } from 'lucide-react';
import InfoPage from '@/components/InfoPage';

const tools = [
  { key: 'ytDlpAvailable', label: 'Video and audio links' },
  { key: 'ffmpegAvailable', label: 'File conversion' },
  { key: 'aria2Available', label: 'Download accelerator' },
  { key: 'nm3u8dlAvailable', label: 'HLS and DASH streams' },
  { key: 'streamlinkAvailable', label: 'Live stream recordings' },
  { key: 'galleryDlAvailable', label: 'Photo galleries' },
] as const;

type Tool = typeof tools[number]['key'];
type Health = { status: string; binaries?: Partial<Record<Tool, boolean>> };
const backend = process.env.NEXT_PUBLIC_BACKEND_URL;
const healthUrl = backend ? backend.replace(/\/$/, '') + '/health' : '/api/health';

export default function StatusPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [checked, setChecked] = useState<Date | null>(null);
  const [checking, setChecking] = useState(true);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const check = async () => {
      setChecking(true);
      try {
        const response = await fetch(healthUrl, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        const result: Health = await response.json();
        if (!response.ok || result.status !== 'ok') throw new Error('Unavailable');
        if (!controller.signal.aborted) setHealth(result);
      } catch {
        if (!controller.signal.aborted) setHealth(null);
      } finally {
        if (!controller.signal.aborted) {
          setChecked(new Date());
          setChecking(false);
        }
      }
    };
    void check();
    const interval = window.setInterval(check, 30_000);
    return () => { window.clearInterval(interval); controller.abort(); };
  }, [refresh]);

  const message = checking ? 'Checking the server…' : health ? 'Server is online' : 'Could not reach the server';
  const Icon = health ? CheckCircle2 : CircleAlert;
  return (
    <InfoPage title="Service status" description="See whether DropSilo can reach the download server and which tools are installed.">
      <div className="rounded-2xl border border-line bg-panel">
        <div className="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6">
          <div role="status">
            <p className="flex items-center gap-2 font-semibold text-ink"><Icon size={18} className={health && !checking ? 'text-success' : 'text-muted'} aria-hidden="true" />{message}</p>
            <p className="mt-1 text-sm text-muted">{checked ? 'Last checked at ' + checked.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Waiting for the first check'}</p>
          </div>
          <button type="button" className="btn-secondary" onClick={() => setRefresh((n) => n + 1)} disabled={checking}>
            <RefreshCw size={16} aria-hidden="true" /> Check again
          </button>
        </div>
        <ul className="divide-y divide-line border-t border-line">
          {tools.map(({ key, label }) => {
            const available = health?.binaries?.[key];
            return <li key={key} className="flex justify-between gap-4 px-5 py-3.5 text-sm sm:px-6">
              <span className="text-secondary">{label}</span>
              <span className={available ? 'shrink-0 text-success' : 'shrink-0 text-muted'}>{available === undefined ? 'Unknown' : available ? 'Installed' : 'Unavailable'}</span>
            </li>;
          })}
        </ul>
      </div>
    </InfoPage>
  );
}
