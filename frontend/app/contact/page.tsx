import Link from 'next/link';
import InfoPage from '@/components/InfoPage';

export default function ContactPage() {
  return (
    <InfoPage title="Help with DropSilo" description="Find a fix for a download problem, check the service, or find out how to report a copyright concern.">
      <ul className="divide-y divide-line rounded-2xl border border-line bg-panel">
        {[
          { href: '/faq', title: 'Download help', text: 'Troubleshoot links, formats, and files that won’t save.' },
          { href: '/status', title: 'Service status', text: 'Check whether the download server is reachable.' },
          { href: '/dmca', title: 'Copyright concerns', text: 'See what to include in a copyright notice and where to send it.' },
        ].map(({ href, title, text }) => (
          <li key={href} className="p-5 sm:p-6">
            <Link href={href} className="font-semibold text-accent hover:underline">{title}</Link>
            <p className="mt-1 text-sm leading-relaxed text-secondary">{text}</p>
          </li>
        ))}
      </ul>
    </InfoPage>
  );
}
