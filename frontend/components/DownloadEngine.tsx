'use client';

import { useState, useId, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import { AlertCircle, Download, FileText, Film, ImageIcon, Music, Radio, Square } from 'lucide-react';
import QualitySelector, { QualityItem } from './QualitySelector';
import ProgressBar from './ProgressBar';
import RippleButton from './magic-ui/RippleButton';
import SuccessCheck from './SuccessCheck';
import { saveFromUrl, useDownloadSession, watchJob } from '@/lib/download-session';

type DownloadProgress = {
  status: string;
  stage?: string;
  percent?: number;
  speed?: string;
  eta?: string;
  downloadedSize?: string;
  totalSize?: string;
  error?: string;
};

export interface AudioOption {
  format: 'mp3' | 'm4a' | 'flac' | 'wav' | 'aac' | 'opus';
  label: string;
  bitrate: string;
  note: string;
  size?: number;
  formattedSize?: string;
}

export interface ExtractResult {
  status: string;
  title: string;
  thumbnail: string;
  duration?: number;
  uploader?: string;
  isLive?: boolean;
  qualities: QualityItem[];
  audioQualities?: AudioOption[];
  platform?: string;
  extractor?: string;
  url?: string;
  isGallery?: boolean;
  original?: { category: 'video' | 'audio' | 'image' | 'document' | 'stream'; filename: string; extension: string; size?: number; recordSeconds?: number };
  images?: Array<{
    id: string;
    url: string;
    thumbnailUrl?: string;
    filename: string;
    extension: string;
    width?: number;
    height?: number;
  }>;
  totalImages?: number;
}

interface Props {
  result: ExtractResult;
  videoUrl?: string;
}

const fallbackAudioOptions: AudioOption[] = [
  { format: 'mp3', label: 'MP3 Audio (320 kbps)', bitrate: '320 kbps', note: 'Highest Quality' },
  { format: 'm4a', label: 'M4A / AAC (Original)', bitrate: '256 kbps', note: 'Direct Demux' },
  { format: 'flac', label: 'FLAC Lossless', bitrate: 'Lossless', note: 'Studio Quality' },
  { format: 'wav', label: 'WAV PCM', bitrate: '1411 kbps', note: 'Uncompressed' },
];

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function DownloadEngine({ result, videoUrl = '' }: Props) {
  const original = result.original;
  const galleryImages = result.isGallery && result.images?.length ? result.images : null;
  const SourceIcon = original?.category === 'image' ? ImageIcon : original?.category === 'document' ? FileText
    : original?.category === 'stream' ? Radio : original?.category === 'video' ? Film : Music;
  const qualities = result.qualities || [];
  const audioOptions = result.audioQualities?.length ? result.audioQualities : fallbackAudioOptions;
  const canDownloadVideo = !original && qualities.length > 0 && result.platform !== 'Spotify';
  const controlsId = useId();
  const [mediaType, setMediaType] = useState<'video' | 'audio'>('video');
  const [thumbnailLoaded, setThumbnailLoaded] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [selectedQualityId, setSelectedQualityId] = useState('');
  const [selectedAudioFormat, setSelectedAudioFormat] = useState('mp3');
  const downloadFormat = canDownloadVideo ? mediaType : 'audio';

  const [isProcessing, setIsProcessing] = useState(false);
  const [canStop, setCanStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const serverJob = useRef<{ id: string; signal: AbortSignal; closeProgress?: () => void } | null>(null);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [saveUrl, setSaveUrl] = useState('');
  const [imageFallback, setImageFallback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [progress, setProgress] = useState<number>();
  const [stage, setStage] = useState('starting');
  const [reconnecting, setReconnecting] = useState(false);
  const [speedMbps, setSpeedMbps] = useState('');
  const [etaSeconds, setEtaSeconds] = useState('');
  const [downloadedSize, setDownloadedSize] = useState('');
  const [totalSize, setTotalSize] = useState('');

  const beginDownload = useDownloadSession();

  const defaultQuality = qualities.reduce<QualityItem | undefined>((preferred, quality) => {
    if (quality.height <= 0 || quality.height > 480) return preferred;
    if (!preferred || quality.height > preferred.height) return quality;
    if (quality.height === preferred.height && (quality.fps ?? 30) <= 30 && (preferred.fps ?? 30) > 30) {
      return quality;
    }
    return preferred;
  }, undefined);
  const activeQuality =
    qualities.find((q) => q.id === selectedQualityId || q.format_id === selectedQualityId) ||
    defaultQuality ||
    qualities[0];
  const activeAudio = audioOptions.find((audio) => audio.format === selectedAudioFormat) ?? audioOptions[0];
  const isVideo = downloadFormat === 'video';
  const formatOptions = isVideo
    ? qualities.map((quality) => {
        const highFrameRate = quality.fps && quality.fps > 30;
        const resolution = highFrameRate ? quality.label.replace(/(p|K)\d+(?=\s|$)/i, '$1') : quality.label;
        const fps = highFrameRate ? ` at ${quality.fps} fps` : '';
        const hdr = quality.isHdr && !resolution.includes('HDR') ? ' HDR' : '';
        const size = quality.formattedSize ? ` (${quality.formattedSize})` : '';
        return { value: quality.id, label: resolution + hdr + fps + size };
      })
    : audioOptions.map((audio) => ({
        value: audio.format,
        label: audio.formattedSize ? `${audio.label} (${audio.formattedSize})` : audio.label,
      }));

  function resetDownload() {
    setIsProcessing(true);
    setDownloadSuccess(false);
    setStopped(false);
    setSaveUrl('');
    setImageFallback('');
    setErrorMsg('');
    setProgress(undefined);
    setStage('starting');
    setReconnecting(false);
    setSpeedMbps('');
    setEtaSeconds('');
    setDownloadedSize('');
    setTotalSize('');
    return beginDownload();
  }

  function finishServerJob() {
    serverJob.current?.closeProgress?.();
    serverJob.current = null;
    setCanStop(false);
    setStopping(false);
    setIsProcessing(false);
  }

  async function stopDownload() {
    const job = serverJob.current;
    if (!job || stopping) return;
    setStopping(true);
    setErrorMsg('');
    try {
      const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL || '';
      const response = await fetch(`${backendBase}/api/download/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
        signal: AbortSignal.any([job.signal, AbortSignal.timeout(10_000)]),
      });
      if (job.signal.aborted || serverJob.current !== job) return;
      if (!response.ok) throw new Error();
      finishServerJob();
      setStopped(true);
    } catch {
      if (job.signal.aborted || serverJob.current !== job) return;
      setStopping(false);
      setErrorMsg('Could not stop this download. Try again.');
    }
  }

  const handleServerDownload = async () => {
    const signal = resetDownload();

    const targetUrl = result.url || videoUrl;
    const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL || '';

    const payload = {
      url: targetUrl,
      cancellable: result.platform !== 'Spotify',
      format: original ? { kind: 'original' } : isVideo ? {
        kind: 'video',
        height: activeQuality?.height,
        fps: activeQuality?.fps,
        format_id: activeQuality?.format_id,
      } : { kind: 'audio', audioFormat: activeAudio.format },
      meta: {
        title: result.title,
        duration: result.duration,
      },
    };

    try {
      const res = await fetch(`${backendBase}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ message: 'Failed to start download' }));
        throw new Error(errJson.message || 'Server error starting download');
      }

      const { jobId, downloadToken } = await res.json();
      if (signal.aborted) return;
      const job: NonNullable<typeof serverJob.current> = { id: jobId, signal };
      serverJob.current = job;
      setCanStop(payload.cancellable);

      job.closeProgress = watchJob<DownloadProgress>(`${backendBase}/api/download/progress?jobId=${jobId}`, signal, (data) => {
        if (data.percent !== undefined) setProgress(data.percent);
        if (data.speed !== undefined) setSpeedMbps(/\d/.test(data.speed) ? data.speed : '');
        if (data.eta !== undefined) setEtaSeconds(data.eta);
        if (data.stage) setStage(data.status === 'queued' ? 'queued' : data.stage);
        if (data.downloadedSize) setDownloadedSize(data.downloadedSize);
        if (data.totalSize) setTotalSize(data.totalSize);

        if (data.status === 'ready') {
          finishServerJob();
          const tokenParam = downloadToken ? `&token=${encodeURIComponent(downloadToken)}` : '';
          const fileUrl = `${backendBase}/api/download/file?jobId=${jobId}${tokenParam}`;
          setSaveUrl(fileUrl);
          setDownloadSuccess(true);
          saveFromUrl(fileUrl);
        } else if (data.status === 'error' || data.status === 'cancelled') {
          finishServerJob();
          if (data.status === 'cancelled') setStopped(true);
          else setErrorMsg(data.error || 'Could not prepare this file. Try again.');
        }
      }, setReconnecting, () => {
        finishServerJob();
        setErrorMsg('Lost the connection to this download. Try again.');
      });
    } catch (err) {
      if (signal.aborted) return;
      finishServerJob();
      setErrorMsg(err instanceof TypeError || (err instanceof DOMException && err.name === 'TimeoutError')
        ? 'Could not reach the download server. Try again.'
        : err instanceof Error ? err.message : 'Could not start this download.');
    }
  };

  const handleDownloadAllZip = async () => {
    if (!galleryImages) return;
    const signal = resetDownload();
    setStage('packaging');
    try {
      const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL || '';
      const res = await fetch(`${backendBase}/api/gallery/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: result.title, images: galleryImages }),
        signal,
      });
      const data = await res.json();
      if (!res.ok || data.status === 'error') {
        throw new Error(data.message || 'Could not create the ZIP file.');
      }
      setDownloadSuccess(true);
      const url = `${backendBase}${data.fileUrl}`;
      setSaveUrl(url);
      saveFromUrl(url, data.downloadFilename);
    } catch (error) {
      if (!signal.aborted) setErrorMsg(error instanceof Error && !(error instanceof TypeError) ? error.message : 'Could not prepare these photos. Try again.');
    } finally {
      if (!signal.aborted) setIsProcessing(false);
    }
  };

  const handleDownloadSingleImage = async (imgUrl: string, filename: string) => {
    const signal = resetDownload();
    setStage('downloading');
    try {
      const res = await fetch(imgUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      if (!res.ok) throw new Error('Could not fetch image.');
      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      saveFromUrl(blobUrl, filename || 'photo.jpg');
      window.setTimeout(() => window.URL.revokeObjectURL(blobUrl), 30_000);
      setDownloadSuccess(true);
    } catch {
      if (!signal.aborted) setImageFallback(imgUrl);
    } finally {
      if (!signal.aborted) setIsProcessing(false);
    }
  };

  const downloadFeedback = downloadSuccess && (
    <motion.div
      key="download-ready"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      className="download-success flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl px-3 py-3.5 text-sm font-semibold"
      role="status"
    >
      <SuccessCheck />
      <span>File ready. Check your browser’s downloads.</span>
      {saveUrl && <a href={saveUrl} className="shrink-0 rounded underline underline-offset-2">Save again</a>}
    </motion.div>
  );

  return (
    <div
      className="media-result-panel mx-auto w-full space-y-5 rounded-2xl border border-line bg-panel p-4 text-left sm:p-6"
      data-gallery={Boolean(galleryImages)}
    >
      <header className="flex items-center gap-3 sm:gap-4">
        <div className="media-result-thumbnail relative shrink-0 overflow-clip rounded-xl border border-line">
          {!thumbnailLoaded && (
            <div className="flex h-full w-full items-center justify-center text-muted" aria-hidden="true">
              {original ? <SourceIcon size={22} /> : galleryImages ? <ImageIcon size={22} /> : canDownloadVideo ? <Film size={22} /> : <Music size={22} />}
            </div>
          )}
          {result.thumbnail && !thumbnailFailed && (
            <Image
              src={result.thumbnail}
              alt=""
              fill
              className="object-cover"
              unoptimized
              loading="eager"
              onLoad={() => setThumbnailLoaded(true)}
              onError={() => { setThumbnailLoaded(false); setThumbnailFailed(true); }}
            />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="media-result-title line-clamp-2 text-base font-semibold leading-snug text-ink sm:text-lg" title={result.title}>
            {result.title}
          </h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {result.platform && <span>{result.platform}</span>}
            {result.duration != null && result.duration > 0 && (
              <span className="tabular-nums">{formatDuration(result.duration)}</span>
            )}
            {result.isLive && <span className="text-danger">Live</span>}
            {result.uploader && <span className="max-w-full truncate">{result.uploader}</span>}
          </div>
        </div>
      </header>

      <div className="divider" role="separator" />

      {galleryImages ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-bold text-ink text-base">
                {galleryImages.length === 1 ? '1 photo' : `${galleryImages.length} photos`}
              </h3>
              <p className="text-xs text-muted">
                {galleryImages.length === 1 ? 'Save the original image.' : 'Save photos one at a time or together.'}
              </p>
            </div>
            {galleryImages.length === 1 ? (
              <button
                onClick={() => handleDownloadSingleImage(galleryImages[0].url, galleryImages[0].filename)}
                disabled={isProcessing}
                className="btn-primary"
              >
                <Download size={16} aria-hidden="true" />
                Save photo
              </button>
            ) : (
              <button
                onClick={handleDownloadAllZip}
                disabled={isProcessing}
                className="btn-primary"
              >
                <Download size={16} aria-hidden="true" />
                Save all as ZIP
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3.5 max-h-[480px] overflow-y-auto p-1 pr-2">
            {galleryImages.map((img, idx) => (
              <div
                key={img.id || idx}
                className="group relative rounded-2xl overflow-hidden border border-tint/[0.1] bg-black/40 aspect-square flex flex-col justify-end"
              >
                <Image
                  src={img.thumbnailUrl || img.url}
                  alt={img.filename || `Photo ${idx + 1}`}
                  fill
                  className="object-cover group-hover:scale-105 transition-transform duration-300"
                  unoptimized
                />
                {galleryImages.length > 1 && <div className="absolute bottom-2 right-2">
                  <button
                    type="button"
                    onClick={() => handleDownloadSingleImage(img.url, img.filename)}
                    disabled={isProcessing}
                    className="grid size-11 place-items-center rounded-lg bg-black/80 text-white transition-colors hover:bg-black disabled:opacity-60"
                    aria-label={`Save photo ${idx + 1}`}
                  >
                    <Download size={16} aria-hidden="true" />
                  </button>
                </div>}
              </div>
            ))}
          </div>
        </div>
      ) : (
          <div className="media-download-controls" data-media-choice={canDownloadVideo}>
            {canDownloadVideo && (
              <fieldset className="min-w-0" disabled={isProcessing}>
                <legend className="download-field-label">Media type</legend>
                <div className="media-type-switch">
                  <label className="media-type-option">
                    <input
                      type="radio"
                      name={controlsId}
                      className="sr-only"
                      checked={isVideo}
                      onChange={() => setMediaType('video')}
                    />
                    <span><Film size={15} aria-hidden="true" /> Video</span>
                  </label>
                  <label className="media-type-option">
                    <input
                      type="radio"
                      name={controlsId}
                      className="sr-only"
                      checked={!isVideo}
                      onChange={() => setMediaType('audio')}
                    />
                    <span><Music size={15} aria-hidden="true" /> Audio</span>
                  </label>
                </div>
              </fieldset>
            )}

            {original ? (
              <div className="min-w-0">
                <p className="download-field-label">{original.category === 'stream' ? 'Output' : 'Original file'}</p>
                <p className="flex flex-wrap gap-x-2 text-sm text-ink">
                  <span>{original.extension.toUpperCase()}</span>
                  {original.recordSeconds ? <span className="text-muted">{original.recordSeconds}s recording</span> : null}
                  {original.size ? <span className="text-muted">{(original.size / (original.size >= 1024 * 1024 ? 1024 * 1024 : 1024)).toFixed(1)} {original.size >= 1024 * 1024 ? 'MB' : 'KB'}</span> : null}
                </p>
              </div>
            ) : <QualitySelector
              id={controlsId + '-option'}
              label={isVideo ? 'Video quality' : 'Audio format'}
              options={formatOptions}
              value={isVideo ? activeQuality.id : activeAudio.format}
              disabled={isProcessing}
              onChange={isVideo ? setSelectedQualityId : setSelectedAudioFormat}
            />}

            <RippleButton
              type="button"
              onClick={handleServerDownload}
              disabled={isProcessing}
              className="btn-primary magic-glare media-download-button"
              aria-busy={isProcessing}
              id="download-btn"
            >
              {isProcessing ? (
                <>
                  <span className="media-download-spinner motion-safe:animate-spin" aria-hidden="true" />
                  <span>Preparing…</span>
                </>
              ) : (
                <>
                  <Download size={17} className="shrink-0" aria-hidden="true" />
                  <span>{original?.recordSeconds ? 'Record live stream' : `Download ${original?.extension.toUpperCase() || (isVideo ? 'MP4' : activeAudio.format.toUpperCase())}`}</span>
                </>
              )}
            </RippleButton>
          </div>

      )}
      <ProgressBar
        progress={progress}
        stage={stopping ? 'stopping' : reconnecting ? 'reconnecting' : stage}
        speedMbps={speedMbps}
        etaSeconds={etaSeconds}
        downloadedSize={downloadedSize}
        totalSize={totalSize}
        isVisible={isProcessing}
        action={canStop && (
          <button type="button" className="btn-secondary shrink-0 justify-center disabled:cursor-not-allowed disabled:opacity-60" onClick={stopDownload} disabled={stopping}>
            <Square size={13} aria-hidden="true" />
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      />
      {stopped && <p className="text-sm text-secondary" role="status">Download stopped.</p>}
      {imageFallback && <p className="text-sm text-secondary" role="status">
        Could not save this photo directly. <a href={imageFallback} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">Open the original photo</a>
      </p>}
      <AnimatePresence>
        {downloadFeedback}
        {errorMsg && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="media-download-error flex items-center gap-2 rounded-md px-3 py-2 text-sm"
            role="alert"
          >
            <AlertCircle size={16} className="shrink-0" aria-hidden="true" />
            {errorMsg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
