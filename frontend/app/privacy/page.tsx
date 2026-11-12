import type { Metadata } from 'next';
import Link from 'next/link';
import InfoPage from '@/components/InfoPage';

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'How DropSilo uses links, temporary files and browser preferences.',
};

const sections = [
  { id: 'zero-logs', title: 'Links and requests', text: 'When you submit a link, DropSilo sends it to the download server. The server uses the link to find available files and may log requests to operate the service and troubleshoot problems.' },
  { id: 'client-processing', title: 'Download files', text: 'The server may temporarily store files while it prepares them for download. A prepared file can expire. If it does, prepare it again.' },
  { id: 'data-collection', title: 'Browser preferences', text: 'DropSilo saves your light or dark theme choice in your browser so it can remember it next time.' },
  { id: 'third-party', title: 'Other sites', text: 'DropSilo connects to the sites you link to and may load previews and fonts from other providers. Those providers handle their requests under their own privacy policies.' },
  { id: 'user-rights', title: 'Clear browser preferences', text: 'Clear site data for DropSilo in your browser settings to reset your saved theme. Your browser manages the files you save and its download history.' },
];

export default function PrivacyPage() {
  return (
    <InfoPage title="Privacy" description="How DropSilo handles links, temporary files and browser preferences.">
      <div className="divide-y divide-line rounded-2xl border border-line bg-panel px-5 sm:px-6">
        {sections.map(({ id, title, text }) => (
          <section id={id} key={id} className="scroll-mt-24 py-5">
            <h2 className="font-semibold text-ink">{title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-secondary">{text}</p>
          </section>
        ))}
      </div>
      <Link href="/cookies" className="mt-5 inline-flex min-h-11 items-center rounded text-sm text-accent hover:underline">More about browser storage</Link>
    </InfoPage>
  );
}
