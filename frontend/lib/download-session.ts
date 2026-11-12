'use client';

import { useEffect, useRef } from 'react';

export function useDownloadSession() {
  const current = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => current.current?.abort(), []);
  return () => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    return controller.signal;
  };
}

export function watchJob<T>(
  url: string,
  signal: AbortSignal,
  onProgress: (data: T, stop: () => void) => void,
  onReconnect: (reconnecting: boolean) => void,
  onLost: () => void,
) {
  if (signal.aborted) return;
  const source = new EventSource(url);
  let retryTimer: number | undefined;
  function stop() {
    source.close();
    window.clearTimeout(retryTimer);
    signal.removeEventListener('abort', stop);
  }
  function lost() {
    stop();
    onReconnect(false);
    onLost();
  }
  signal.addEventListener('abort', stop, { once: true });
  source.onopen = () => {
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
    onReconnect(false);
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      lost();
    } else if (retryTimer === undefined) {
      onReconnect(true);
      retryTimer = window.setTimeout(lost, 18_000);
    }
  };
  source.onmessage = (event) => {
    let data: T;
    try { data = JSON.parse(event.data); } catch { return; }
    onProgress(data, stop);
  };
  return stop;
}

export function saveFromUrl(url: string, filename?: string) {
  const link = document.createElement('a');
  link.href = url;
  if (filename) link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
