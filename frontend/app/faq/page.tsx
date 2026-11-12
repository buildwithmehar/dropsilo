'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import InfoPage from '@/components/InfoPage';

const questions = [
  { q: 'Do I need an account?', a: 'You can use the main downloader without an account. Advanced tools use an DropSilo access key, and some also need an account with the source site.' },
  { q: 'What can I save?', a: 'Try a public video, audio, photo album, playlist, live stream or direct file link. The options depend on the link.' },
  { q: 'Why is the quality or format I want missing?', a: 'Each source offers different formats. A video can only be saved in the qualities available for that link.' },
  { q: 'Why didn’t my download start?', a: 'Check that the link opens in your browser without signing in. If DropSilo has prepared the file, check your browser’s downloads or select the save link again.' },
  { q: 'Where did my file go?', a: 'Look in your browser’s download list or your device’s Downloads folder. Files can be saved to a different folder if you chose one in your browser.' },
  { q: 'What is a ZIP file?', a: 'A ZIP keeps several files together. Open it with your device’s file manager to get the individual photos or playlist items.' },
  { q: 'Why does a live recording stop?', a: 'DropSilo records a limited part of a live stream. The download options show the recording length before you start.' },
  { q: 'Can I save a website or an e-book?', a: 'Paste direct file links in the main downloader. Open Advanced tools for website copies, supported book links and audiobook exports.' },
];

export default function FAQPage() {
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const matches = questions.filter(({ q, a }) => (q + ' ' + a).toLowerCase().includes(query));
  return (
    <InfoPage title="Download help" description="Quick answers about links, formats and saving files.">
      <label htmlFor="faq-search" className="download-field-label">Search questions</label>
      <input id="faq-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)}
        className="info-input mb-5 w-full rounded-lg px-3.5 py-3 text-base text-ink" placeholder="Try “ZIP” or “account”" />
      <div className="divide-y divide-line rounded-2xl border border-line bg-panel">
        {matches.length ? matches.map(({ q, a }) => (
          <details key={q} className="group px-5 py-1">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-sm py-2 text-sm font-semibold text-ink">
              {q}<ChevronDown size={16} aria-hidden="true" className="shrink-0 text-muted group-open:rotate-180" />
            </summary>
            <p className="pb-4 pr-4 text-sm leading-relaxed text-secondary">{a}</p>
          </details>
        )) : <p className="p-5 text-sm text-secondary" role="status">No matching questions. Try a shorter search.</p>}
      </div>
      <Link href="/status" className="mt-6 inline-flex min-h-11 items-center rounded text-sm text-accent hover:underline">Check service status</Link>
    </InfoPage>
  );
}
