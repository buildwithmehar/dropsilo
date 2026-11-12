import Link from 'next/link';
import InfoPage from '@/components/InfoPage';

export default function AboutPage() {
  return (
    <InfoPage title="About DropSilo" description="DropSilo brings common download tools together so you can save public media and files from one place.">
      <div className="space-y-6 rounded-2xl border border-line bg-panel p-5 text-sm leading-relaxed text-secondary sm:p-6">
        <p>Paste a public link to see what the source offers. You can save the original file or choose a different format when available.</p>
        <p>Advanced tools cover tasks such as saving a copy of a website, downloading books, and opening audiobook exports. Some tools require an access key or a provider account.</p>
      </div>
      <div className="mt-8 flex flex-wrap gap-4">
        <Link href="/#video-url-input" className="btn-primary">Open downloader</Link>
        <Link href="/privacy" className="btn-secondary">Privacy</Link>
      </div>
    </InfoPage>
  );
}
