import type { Metadata } from 'next';
import Link from 'next/link';
import InfoPage from '@/components/InfoPage';

export const metadata: Metadata = {
  title: 'Terms of service',
  description: 'Terms for using the DropSilo downloader.',
};

export default function TermsPage() {
  return (
    <InfoPage title="Terms of service" description="These terms apply when you use DropSilo.">
      <div className="divide-y divide-line rounded-2xl border border-line bg-panel px-5 sm:px-6">
        <section className="py-5">
          <h2 className="font-semibold text-ink">Personal use</h2>
          <p className="mt-2 text-sm leading-relaxed text-secondary">DropSilo is for personal, non-commercial use. Save content only when you have permission or a legal right to download it. You are responsible for how you use the files you save.</p>
        </section>
        <section className="py-5">
          <h2 className="font-semibold text-ink">Service limits</h2>
          <p className="mt-2 text-sm leading-relaxed text-secondary">DropSilo limits requests to prevent abuse. Automated bot traffic and bulk scraping of the service are prohibited.</p>
        </section>
        <section className="py-5">
          <h2 className="font-semibold text-ink">Availability</h2>
          <p className="mt-2 text-sm leading-relaxed text-secondary">DropSilo is provided as is and as available. Download options and availability depend on the source site and the download server.</p>
        </section>
      </div>
      <Link href="/dmca" className="mt-5 inline-flex min-h-11 items-center rounded text-sm text-accent hover:underline">Copyright requests</Link>
    </InfoPage>
  );
}
