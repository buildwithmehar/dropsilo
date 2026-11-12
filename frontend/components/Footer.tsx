import Link from 'next/link';
import Logo from '@/components/Logo';

const linkGroups = [
  { title: 'Downloads', links: [['/', 'Downloader'], ['/advanced', 'Advanced tools'], ['/features', 'What you can save'], ['/how-it-works', 'How it works']] },
  { title: 'Help', links: [['/faq', 'Download help'], ['/status', 'Service status'], ['/contact', 'Contact'], ['/about', 'About DropSilo']] },
  { title: 'Policies', links: [['/privacy', 'Privacy'], ['/terms', 'Terms'], ['/dmca', 'Copyright'], ['/cookies', 'Cookies']] },
];

export default function Footer() {
  return (
    <footer className="border-t border-line bg-panel px-5 py-9 sm:py-12">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-8 lg:grid-cols-[1fr_1.5fr] lg:gap-12">
          <div>
            <Link href="/" className="inline-flex min-h-11 items-center rounded-sm">
              <Logo size={28} showText />
            </Link>
            <p className="mt-2 text-sm text-secondary">Paste a link. Save your file.</p>
          </div>
          <nav className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3" aria-label="Footer">
            {linkGroups.map(({ title, links }) => (
              <div key={title}>
                <p className="mb-1 text-sm font-semibold text-ink">{title}</p>
                <ul>
                  {links.map(([href, label]) => (
                    <li key={href}>
                      <Link href={href} className="inline-flex min-h-9 items-center rounded-sm text-sm text-secondary hover:text-ink hover:underline">{label}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <p className="mt-7 border-t border-line pt-5 text-xs text-muted">© {new Date().getFullYear()} DropSilo. Save only content you have permission to download.</p>
      </div>
    </footer>
  );
}
