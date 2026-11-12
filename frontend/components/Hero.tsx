'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { AlertCircle, Check, Clipboard, FileText, Film, Image, Link2, LoaderCircle, Music2, Search, X } from 'lucide-react';
import DownloadEngine, { ExtractResult } from './DownloadEngine';
import PlaylistBatchView, { PlaylistData } from './PlaylistBatchView';
import BorderBeam from './magic-ui/BorderBeam';
import RippleButton from './magic-ui/RippleButton';
import TextAnimate from './magic-ui/TextAnimate';
import SuccessCheck from './SuccessCheck';

const headingLines = [
  { text: 'Download videos,' },
  { text: 'audio and files.', className: 'text-accent' },
];

function detectPlatform(url: string) {
  const cleanUrl = url.trim();
  if (!/^https?:\/\//i.test(cleanUrl)) return null;

  let host: string;
  try {
    host = new URL(cleanUrl).hostname.replace(/\.$/, '');
  } catch {
    return null;
  }

  const matches = (domain: string) => host === domain || host.endsWith('.' + domain);
  if (matches('youtube.com') || matches('youtu.be')) return { name: 'YouTube' };
  if (matches('spotify.com') || matches('spotify.link')) return { name: 'Spotify' };
  if (matches('soundcloud.com')) return { name: 'SoundCloud' };
  if (matches('pin.it') || /(^|\.)pinterest\.(?:com|[a-z]{2}|(?:co|com)\.[a-z]{2})$/.test(host)) return { name: 'Pinterest' };
  if (matches('tiktok.com')) return { name: 'TikTok' };
  if (matches('instagram.com')) return { name: 'Instagram' };
  if (matches('twitter.com') || matches('x.com')) return { name: 'Twitter / X' };
  if (matches('reddit.com')) return { name: 'Reddit' };
  if (matches('facebook.com') || matches('fb.watch')) return { name: 'Facebook' };
  if (matches('vimeo.com')) return { name: 'Vimeo' };
  return null;
}

export default function Hero() {
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [playlistResult, setPlaylistResult] = useState<PlaylistData | null>(null);
  const [pasted, setPasted] = useState(false);
  const [beamPass, setBeamPass] = useState(0);
  const [checkedUrl, setCheckedUrl] = useState('');
  const [pasteHint, setPasteHint] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const platformInfo = detectPlatform(url);
  const fieldActionLabel = url ? 'Clear link' : 'Paste link from clipboard';

  useEffect(() => {
    if (result || playlistResult) resultRef.current?.focus();
  }, [result, playlistResult]);

  useEffect(() => {
    if (!pasted) return;
    const timer = window.setTimeout(() => setPasted(false), 2000);
    return () => window.clearTimeout(timer);
  }, [pasted]);

  function updateLink(value: string) {
    setUrl(value);
    setError(null);
    setPasteHint('');
    setPasted(false);
    setResult(null);
    setPlaylistResult(null);
    setCheckedUrl('');
  }

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (inputRef.current?.value || inputRef.current?.disabled) return;
      if (text.trim()) {
        updateLink(text.trim());
        setPasted(true);
      } else {
        setPasteHint('Copy a link first, then paste it here.');
      }
    } catch {
      if (!inputRef.current?.value) setPasteHint('Paste the link directly into the field.');
    } finally {
      inputRef.current?.focus();
    }
  };

  const handleClear = () => {
    updateLink('');
    inputRef.current?.focus();
  };

  const handleExtract = async () => {
    if (isLoading) return;

    if (!url.trim()) {
      setError('Paste a link to get started.');
      inputRef.current?.focus();
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    } catch {
      setError('Enter a web link starting with https:// or http://.');
      inputRef.current?.focus();
      return;
    }

    setError(null);
    setPasteHint('');
    setIsLoading(true);
    setResult(null);
    setPlaylistResult(null);

    const cleanUrl = url.trim();

    try {
      const isPlaylist =
        (/(^|\.)(youtube\.com|youtu\.be)$/.test(parsed.hostname) &&
          (parsed.pathname === '/playlist' || parsed.searchParams.has('list'))) ||
        (parsed.hostname === 'open.spotify.com' && /^\/(?:intl-[a-z-]+\/)?(playlist|album)\//i.test(parsed.pathname));
      const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL || '';
      const endpoint = isPlaylist ? '/api/playlist/expand' : '/api/extract';
      const res = await fetch(backendBase + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl }),
        signal: AbortSignal.timeout(75_000),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.status === 'error') {
        throw new Error(data?.message || 'Could not open this link. Check the address and try again.');
      }
      setCheckedUrl(cleanUrl);
      if (isPlaylist) setPlaylistResult(data as PlaylistData);
      else setResult(data as ExtractResult);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'TimeoutError') setError('This link took too long to open. Try again.');
      else if (err instanceof TypeError) setError('Could not reach DropSilo. Check your connection and try again.');
      else setError(err instanceof Error ? err.message : 'Could not open this link. Try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="downloader-hero relative px-4" aria-labelledby="hero-headline">
      <div className="relative mx-auto flex w-full max-w-5xl flex-col items-center text-center">
        <header className="min-w-0">
          <h1 id="hero-headline" className="hero-headline" aria-label="Download videos, audio and files">
            <TextAnimate lines={headingLines} />
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-secondary md:text-lg">
            Paste a public link to see what you can save. No account needed.
          </p>
        </header>

        <form
          className="relative mt-8 w-full max-w-[42rem]"
          onSubmit={(event) => {
            event.preventDefault();
            void handleExtract();
          }}
          noValidate
          aria-label="Get download options"
        >
          <div
            className="downloader-console"
            data-detected={Boolean(checkedUrl && !error)}
            data-invalid={Boolean(error)}
          >
            {!error && <BorderBeam pass={beamPass} busy={isLoading} />}
            <div className="download-field">
              <span className="icon-swap text-muted" data-swap={pasted} aria-hidden="true">
                <Link2 size={18} />
                <Check size={18} className="text-success" />
              </span>
              <label htmlFor="video-url-input" className="sr-only">Media or file link</label>
              <input
                ref={inputRef}
                type="url"
                value={url}
                onPointerDown={() => setBeamPass((pass) => pass + 1)}
                onChange={(event) => updateLink(event.target.value)}
                placeholder="Paste a link here"
                className="download-link-input"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'url-error' : pasteHint ? 'paste-hint' : undefined}
                disabled={isLoading}
                id="video-url-input"
                autoComplete="url"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={url ? handleClear : handlePaste}
                disabled={isLoading}
                className="field-action"
                aria-label={fieldActionLabel}
                title={fieldActionLabel}
              >
                <span className="icon-swap" data-swap={Boolean(url)} aria-hidden="true">
                  <Clipboard size={16} />
                  <X size={16} />
                </span>
                <span className="hidden sm:inline" aria-hidden="true">{url ? 'Clear' : 'Paste'}</span>
              </button>
            </div>

            <RippleButton
              type="submit"
              disabled={isLoading}
              className="btn-primary magic-glare extract-button"
              aria-busy={isLoading}
              id="extract-btn"
            >
              <span>{isLoading ? 'Checking link…' : 'Find download'}</span>
              <span className="icon-swap" data-swap={isLoading} aria-hidden="true">
                <Search size={16} />
                <span>{isLoading && <LoaderCircle size={16} className="motion-safe:animate-spin" />}</span>
              </span>
            </RippleButton>
          </div>

          <div className="download-feedback">
            <span className="sr-only" role="status">
              {isLoading ? 'Loading download options' : pasted ? 'Link pasted' : ''}
            </span>
            {error ? (
              <p id="url-error" className="download-error" role="alert">
                <AlertCircle size={16} className="shrink-0" aria-hidden="true" />
                {error}
              </p>
            ) : pasteHint ? <p id="paste-hint" className="text-sm text-muted" role="status">{pasteHint}</p>
              : checkedUrl ? <p className="platform-detection"><SuccessCheck size={14} /> Download options ready</p>
                : platformInfo && !isLoading ? <p className="text-sm text-muted">{platformInfo.name} link</p> : null}
          </div>
        </form>

        <ul className="flex flex-wrap items-center justify-center gap-2" aria-label="Supported downloads">
          {[
            { icon: Film, text: 'Video' },
            { icon: Music2, text: 'Audio' },
            { icon: Image, text: 'Photos' },
            { icon: FileText, text: 'PDFs and books' },
          ].map(({ icon: Icon, text }) => (
            <li key={text} className="platform-chip">
              <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
              {text}
            </li>
          ))}
        </ul>
        <Link href="/advanced" className="mt-4 inline-flex min-h-11 items-center rounded text-sm text-accent hover:underline">
          Explore advanced tools
        </Link>
      </div>

      {playlistResult && (
        <div ref={resultRef} tabIndex={-1} className="download-result relative z-10 mx-auto mt-8 w-full max-w-4xl scroll-mt-24" role="region" aria-label="Playlist download options">
          <PlaylistBatchView playlist={playlistResult} playlistUrl={checkedUrl} />
        </div>
      )}

      {result && !playlistResult && (
        <div ref={resultRef} tabIndex={-1} className="download-result relative z-10 mx-auto mt-8 w-full max-w-3xl scroll-mt-24" role="region" aria-label="Download options">
          <DownloadEngine result={result} videoUrl={checkedUrl} />
        </div>
      )}
    </section>
  );
}
