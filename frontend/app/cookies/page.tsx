import type { Metadata } from 'next';
import Link from 'next/link';
import InfoPage from '@/components/InfoPage';

export const metadata: Metadata = {
  title: 'Cookies and browser storage',
  description: 'What DropSilo saves in your browser.',
};

export default function CookiesPage() {
  return (
    <InfoPage title="Cookies and browser storage" description="What DropSilo remembers on this device.">
      <div className="divide-y divide-line rounded-2xl border border-line bg-panel px-5 sm:px-6">
        <section className="py-5">
          <h2 className="font-semibold text-ink">Theme preference</h2>
          <p className="mt-2 text-sm leading-relaxed text-secondary">When you change the theme, DropSilo stores your light or dark preference in your browser for your next visit.</p>
        </section>
        <section className="py-5">
          <h2 className="font-semibold text-ink">Reset your preference</h2>
          <p className="mt-2 text-sm leading-relaxed text-secondary">Clear site data for DropSilo in your browser settings, or use the theme button at the top of the page to switch.</p>
        </section>
      </div>
      <Link href="/privacy" className="mt-5 inline-flex min-h-11 items-center rounded text-sm text-accent hover:underline">Read the privacy page</Link>
    </InfoPage>
  );
}
