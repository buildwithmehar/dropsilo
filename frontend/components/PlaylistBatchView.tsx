'use client';

import { useState, useId } from 'react';
import {
  ListVideo,
  CheckSquare,
  Square,
  Download,
  AlertCircle,
  Film,
  Music,
  Clock,
  Archive,
  Subtitles,
} from 'lucide-react';
import RippleButton from './magic-ui/RippleButton';
import SuccessCheck from './SuccessCheck';
import { saveFromUrl, useDownloadSession, watchJob } from '@/lib/download-session';

export interface PlaylistEntry {
  id: string;
  title: string;
  url: string;
  duration?: number;
  thumbnail?: string;
}

export interface PlaylistData {
  playlistTitle: string;
  totalEntries: number;
  entries: PlaylistEntry[];
}

interface ItemStatus {
  url: string;
  title?: string;
  status: string; // 'queued' | 'downloading' | 'completed' | 'failed'
  percent: number;
}

interface BatchProgressState {
  batchId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  totalItems: number;
  completedItems: number;
  failedItems: number;
  overallPercent: number;
  zipFilename: string;
  downloadToken?: string;
  error?: string;
  itemStatuses: ItemStatus[];
}

interface Props {
  playlist: PlaylistData;
  playlistUrl: string;
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function PlaylistBatchView({ playlist, playlistUrl }: Props) {
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(
    () => new Set(playlist.entries.map((e) => e.url))
  );

  const fieldId = useId();
  const beginDownload = useDownloadSession();
  const isSpotify = /^https?:\/\/open\.spotify\.com\//i.test(playlistUrl);
  const [downloadKind, setDownloadKind] = useState<'video' | 'audio'>(isSpotify ? 'audio' : 'video');
  const [selectedAudioFormat, setSelectedAudioFormat] = useState<'mp3' | 'm4a' | 'flac' | 'wav'>('mp3');
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(false);
  const [subtitleLang, setSubtitleLang] = useState('en');
  const [thumbnailEnabled, setThumbnailEnabled] = useState(false);
  const [filenamePreset, setFilenamePreset] = useState<string>('title');

  const [isProcessing, setIsProcessing] = useState(false);
  const [batchState, setBatchState] = useState<BatchProgressState | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const allSelected = playlist.entries.every((entry) => selectedUrls.has(entry.url));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedUrls(new Set());
    } else {
      setSelectedUrls(new Set(playlist.entries.map((e) => e.url)));
    }
  };

  const toggleItem = (url: string) => {
    const next = new Set(selectedUrls);
    if (next.has(url)) next.delete(url);
    else next.add(url);
    setSelectedUrls(next);
  };

  const handleStartBatchDownload = async () => {
    if (selectedUrls.size === 0) {
      setErrorMsg('Choose at least one item.');
      return;
    }

    setIsProcessing(true);
    setErrorMsg('');
    setBatchState(null);
    setDownloadSuccess(false);
    setReconnecting(false);
    const signal = beginDownload();

    const items = playlist.entries
      .filter((e) => selectedUrls.has(e.url))
      .map((e) => ({ url: e.url, title: e.title }));

    const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL || '';

    const payload = {
      url: playlistUrl,
      items,
      format: {
        kind: downloadKind,
        audioFormat: downloadKind === 'audio' ? selectedAudioFormat : undefined,
        subtitles: subtitlesEnabled,
        subtitleLangs: subtitlesEnabled ? [subtitleLang] : undefined,
        thumbnail: thumbnailEnabled,
        filenameTemplate: filenamePreset !== 'default' ? filenamePreset : undefined,
      },
    };

    try {
      const res = await fetch(`${backendBase}/api/playlist/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ message: 'Failed to start batch download' }));
        throw new Error(errJson.message || 'Server error starting batch job');
      }

      const { batchId, downloadToken } = await res.json();

      watchJob<BatchProgressState>(`${backendBase}/api/playlist/progress?batchId=${batchId}`, signal, (data, stop) => {
        setBatchState({ ...data, downloadToken });
        if (data.status === 'completed' || data.status === 'failed') {
          stop();
          setIsProcessing(false);
          if (data.status === 'completed') setDownloadSuccess(true);
          else setErrorMsg(data.error || 'Could not prepare this playlist. Try again.');
        }
      }, setReconnecting, () => {
        setIsProcessing(false);
        setErrorMsg('Lost the connection to this playlist. Try again.');
      });
    } catch (err) {
      if (signal.aborted) return;
      setIsProcessing(false);
      setErrorMsg(err instanceof Error && !(err instanceof TypeError) && err.name !== 'TimeoutError'
        ? err.message : 'Could not reach the download server. Try again.');
    }
  };

  const handleDownloadZip = () => {
    if (!batchState || !batchState.downloadToken) return;
    const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL || '';
    const zipUrl = `${backendBase}/api/playlist/download/file?batchId=${batchState.batchId}&token=${encodeURIComponent(batchState.downloadToken)}`;
    saveFromUrl(zipUrl);
  };

  return (
    <div
      className="result-panel w-full rounded-3xl border border-line bg-panel p-4 sm:p-6 md:p-8 space-y-6 text-left"
    >
      {/* ── Playlist Header ── */}
      <div className="flex flex-col md:flex-row gap-5 justify-between items-start md:items-center pb-5 border-b border-tint/[0.1]">
        <div className="space-y-1.5">
          <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold"
            style={{
              background: 'rgba(139,92,246,0.15)',
              border: '1px solid rgba(139,92,246,0.3)',
              color: 'var(--accent-text)',
            }}
          >
            <ListVideo className="w-3.5 h-3.5" />
            Playlist · {playlist.entries.length} items
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold text-ink leading-tight">
            {playlist.playlistTitle}
          </h2>
          <p className="text-xs text-muted">
            Choose what to save together in a ZIP file.
          </p>
        </div>

        <button
          onClick={toggleSelectAll}
          disabled={isProcessing}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-tint/[0.05] hover:bg-tint/[0.1] text-secondary border border-tint/[0.1] transition-colors flex-shrink-0"
        >
          {allSelected ? (
            <>
              <CheckSquare className="w-4 h-4 text-accent" />
              <span>Clear selection</span>
            </>
          ) : (
            <>
              <Square className="w-4 h-4 opacity-50" />
              <span>Select all</span>
            </>
          )}
        </button>
      </div>

      {/* ── Download Options Row ── */}
      <fieldset disabled={isProcessing} className="grid min-w-0 grid-cols-1 gap-4 rounded-xl border border-line p-4 sm:grid-cols-2">
        <legend className="sr-only">Playlist options</legend>
        {/* Media Format */}
        <div className="space-y-1.5">
          <p className="download-field-label">Media type</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDownloadKind('video')}
              disabled={isSpotify}
              aria-pressed={downloadKind === 'video'}
              className={`flex-1 py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border transition-colors ${
                downloadKind === 'video'
                  ? 'bg-violet-600/30 text-accent border-violet-500/50'
                  : 'bg-tint/[0.05] text-muted border-tint/[0.1]'
              }`}
            >
              <Film size={13} /> Video (MP4)
            </button>
            <button
              onClick={() => setDownloadKind('audio')}
              aria-pressed={downloadKind === 'audio'}
              className={`flex-1 py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border transition-colors ${
                downloadKind === 'audio'
                  ? 'bg-violet-600/30 text-accent border-violet-500/50'
                  : 'bg-tint/[0.05] text-muted border-tint/[0.1]'
              }`}
            >
              <Music size={13} /> Audio
            </button>
          </div>
        </div>

        {/* Audio Format Selector */}
        {downloadKind === 'audio' && (
          <div className="space-y-1.5">
            <label htmlFor={fieldId + '-audio'} className="download-field-label">
              Audio format
            </label>
            <select
              id={fieldId + '-audio'}
              value={selectedAudioFormat}
              onChange={(e) => setSelectedAudioFormat(e.target.value as typeof selectedAudioFormat)}
              className="w-full bg-tint/[0.1] border border-tint/[0.15] rounded-xl px-3 py-2 text-xs font-semibold text-ink outline-none"
            >
              <option value="mp3" className="bg-panel text-ink">MP3 (320 kbps)</option>
              <option value="m4a" className="bg-panel text-ink">M4A / AAC (Original)</option>
              <option value="flac" className="bg-panel text-ink">FLAC Lossless</option>
              <option value="wav" className="bg-panel text-ink">WAV PCM</option>
            </select>
          </div>
        )}

        {/* Subtitle Options */}
        <div className="space-y-1.5">
          <p className="download-field-label">Extras</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSubtitlesEnabled(!subtitlesEnabled)}
              aria-pressed={subtitlesEnabled}
              className={`py-2 px-3 rounded-xl text-xs font-semibold flex items-center gap-1.5 border transition-colors ${
                subtitlesEnabled
                  ? 'bg-violet-600/30 text-accent border-violet-500/50'
                  : 'bg-tint/[0.05] text-muted border-tint/[0.1]'
              }`}
            >
              <Subtitles size={13} /> Subtitles
            </button>
            {subtitlesEnabled && (
              <select
                aria-label="Subtitle language"
                value={subtitleLang}
                onChange={(e) => setSubtitleLang(e.target.value)}
                className="bg-tint/[0.1] border border-tint/[0.15] rounded-xl px-2 py-2 text-xs font-semibold text-ink outline-none"
              >
                <option value="en" className="bg-panel">English (en)</option>
                <option value="es" className="bg-panel">Spanish (es)</option>
                <option value="fr" className="bg-panel">French (fr)</option>
                <option value="de" className="bg-panel">German (de)</option>
                <option value="hi" className="bg-panel">Hindi (hi)</option>
                <option value="ja" className="bg-panel">Japanese (ja)</option>
              </select>
            )}
            <label className="inline-flex min-h-9 items-center gap-2 px-1 text-xs text-secondary">
              <input type="checkbox" checked={thumbnailEnabled} onChange={(event) => setThumbnailEnabled(event.target.checked)} />
              Include cover images
            </label>
          </div>
        </div>

        {/* Filename Presets */}
        <div className="space-y-1.5">
          <label htmlFor={fieldId + '-filename'} className="download-field-label">
            File names
          </label>
          <select
            id={fieldId + '-filename'}
            value={filenamePreset}
            onChange={(e) => setFilenamePreset(e.target.value)}
            className="w-full bg-tint/[0.1] border border-tint/[0.15] rounded-xl px-3 py-2 text-xs font-semibold text-ink outline-none"
          >
            <option value="title" className="bg-panel">Title</option>
            <option value="uploader_title" className="bg-panel">Uploader and title</option>
            <option value="artist_title" className="bg-panel">Artist and title</option>
            <option value="date_title" className="bg-panel">Date and title</option>
          </select>
        </div>
      </fieldset>

      {/* ── Item Batch List ── */}
      <div className="space-y-2 max-h-[360px] overflow-y-auto pr-2 custom-scrollbar">
        {playlist.entries.map((entry, idx) => {
          const isSelected = selectedUrls.has(entry.url);
          const liveItem = batchState?.itemStatuses.find((s) => s.url === entry.url);

          return (
            <label
              key={entry.id + '-' + idx}
              className={`p-3.5 rounded-2xl border transition-colors cursor-pointer flex items-center justify-between gap-4 ${
                isSelected
                  ? 'bg-tint/[0.06] border-tint/[0.15]'
                  : 'bg-tint/[0.02] border-tint/[0.05] opacity-60 hover:opacity-80'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <input type="checkbox" className="size-4 shrink-0" aria-label={entry.title}
                  checked={isSelected} disabled={isProcessing} onChange={() => toggleItem(entry.url)} />

                <span className="font-mono text-xs text-muted flex-shrink-0 w-6">
                  {String(idx + 1).padStart(2, '0')}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink truncate" title={entry.title}>
                    {entry.title}
                  </p>
                  {entry.duration && entry.duration > 0 && (
                    <span className="text-[11px] text-muted flex items-center gap-1 mt-0.5">
                      <Clock size={11} /> {formatDuration(entry.duration)}
                    </span>
                  )}
                </div>
              </div>

              {/* Progress status badge for batch execution */}
              {liveItem && (
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="hidden h-2 w-16 overflow-hidden rounded-full bg-tint/[0.1] sm:block">
                    <div
                      className="h-full bg-action"
                      style={{ width: `${liveItem.percent}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono font-bold text-secondary w-10 text-right">
                    {liveItem.status === 'failed' ? 'Failed' : liveItem.status === 'completed' ? '100%' : `${liveItem.percent}%`}
                  </span>
                </div>
              )}
            </label>
          );
        })}
      </div>

      {/* ── Overall Progress Bar ── */}
      <span className="sr-only" role="status">{downloadSuccess ? 'Playlist ZIP ready to save' : reconnecting ? 'Reconnecting' : ''}</span>
      {batchState && (
        <div
          className="batch-progress space-y-2 rounded-xl border border-line p-4"
          data-complete={downloadSuccess}
        >
          <div className="batch-progress-heading flex justify-between gap-2 text-sm font-semibold text-ink">
            <span className="flex items-center gap-1.5">
              {downloadSuccess && <SuccessCheck size={14} />}
              {downloadSuccess ? 'Playlist ZIP ready' : reconnecting ? 'Reconnecting…' : batchState.status === 'failed' ? 'Could not finish' : 'Preparing playlist…'}
            </span>
            <span>{batchState.overallPercent}%</span>
          </div>
          <div className="progress-track" role="progressbar" aria-label="Playlist progress" aria-valuenow={batchState.overallPercent}>
            <div
              className="progress-fill batch-progress-fill"
              style={{ transform: `scaleX(${batchState.overallPercent / 100})` }}
            />
          </div>
          <p className="text-[11px] font-medium text-muted text-right">
            {batchState.completedItems} of {batchState.totalItems} saved{batchState.failedItems > 0 ? ` · ${batchState.failedItems} failed` : ''}
          </p>
        </div>
      )}

      {/* ── Download CTA Buttons ── */}
      <div className="space-y-3 pt-2">
        {!downloadSuccess ? (
          <RippleButton
            onClick={handleStartBatchDownload}
            disabled={isProcessing || selectedUrls.size === 0}
            className="btn-primary magic-glare download-cta"
          >
            {isProcessing ? (
              <>
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>{reconnecting ? 'Reconnecting…' : 'Preparing ZIP…'}</span>
              </>
            ) : (
              <>
                <Download className="w-5 h-5" />
                <span>Prepare ZIP · {selectedUrls.size} selected</span>
              </>
            )}
          </RippleButton>
        ) : (
          <div className="flex flex-wrap gap-3">
            <RippleButton onClick={handleDownloadZip} className="btn-primary magic-glare">
              <Archive size={17} aria-hidden="true" /> Save ZIP
            </RippleButton>
            <button type="button" className="btn-secondary" onClick={() => { setDownloadSuccess(false); setBatchState(null); }}>
              Prepare another ZIP
            </button>
          </div>
        )}

        {/* Error message */}
        {errorMsg && (
          <div role="alert" className="media-download-error flex items-center gap-2 rounded-xl px-3 py-2 text-sm">
            <AlertCircle className="w-4 h-4" />
            {errorMsg}
          </div>
        )}
      </div>
    </div>
  );
}
