import Link from 'next/link';
import InfoPage from '@/components/InfoPage';

const steps = [
  { title: 'Copy the link', text: 'Open the public video, photo album, stream or file you want to save. Copy its web address or share link.' },
  { title: 'Find your options', text: 'Paste the link into DropSilo and select Find download. For video or audio, pick the quality or format you want.' },
  { title: 'Save the file', text: 'Select Download. DropSilo prepares your file and hands it to your browser. For a playlist or gallery, you may get a ZIP file.' },
];

export default function HowItWorksPage() {
  return (
    <InfoPage title="How to download" description="Start with a public link. You can use the main downloader without an account.">
      <ol className="divide-y divide-line rounded-2xl border border-line bg-panel">
        {steps.map(({ title, text }, index) => (
          <li key={title} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 p-5 sm:p-6">
            <span className="font-mono text-sm text-accent" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <div><h2 className="font-semibold text-ink">{title}</h2><p className="mt-1 text-sm leading-relaxed text-secondary">{text}</p></div>
          </li>
        ))}
      </ol>
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <Link href="/#video-url-input" className="btn-primary">Open downloader</Link>
        <Link href="/faq" className="btn-secondary">Get help</Link>
      </div>
    </InfoPage>
  );
}
