'use client';

import React from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-canvas text-ink min-h-screen flex items-center justify-center p-6 antialiased">
        <div className="max-w-md w-full p-8 rounded-3xl bg-tint/[0.03] border border-tint/[0.1] backdrop-blur-2xl text-center space-y-6 shadow-2xl">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-danger mx-auto flex items-center justify-center font-bold text-2xl">
            !
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-black text-ink">Critical System Reset</h1>
            <p className="text-sm text-muted">
              An unrecoverable layout fault occurred. Please reload the core application bundle.
            </p>
          </div>
          <button
            onClick={() => reset()}
            className="btn-primary download-cta"
          >
            Reload Application Engine
          </button>
        </div>
      </body>
    </html>
  );
}
