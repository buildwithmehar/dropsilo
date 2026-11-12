import FloatingNav from '@/components/FloatingNav';
import Hero from '@/components/Hero';
import HomeMotion from '@/components/HomeMotion';
import FeatureBento from '@/components/FeatureBento';
import Footer from '@/components/Footer';
import { ArrowRight, Link2, Search, Download } from 'lucide-react';
import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  description:
    'Paste a public link to save video, audio, photos or files with DropSilo.',
  keywords: ['video downloader', 'youtube downloader', 'tiktok downloader', 'instagram downloader', 'facebook downloader', 'free video downloader'],
  openGraph: {
    title: 'DropSilo',
    siteName: 'DropSilo',
    description: 'Find downloads for public links and save them to your device.',
    type: 'website',
  },
};

const steps = [
  {
    id: 'step-1',
    number: '01',
    icon: <Link2 size={20} strokeWidth={1.5} />,
    title: 'Copy a link',
    desc: 'Copy the address from your browser or use the share button in an app.',
    badge: 'Step 1',
  },
  {
    id: 'step-2',
    number: '02',
    icon: <Search size={20} strokeWidth={1.5} />,
    title: 'Find download options',
    desc: 'Paste the link and select Find download. Choose a format or quality if options are available.',
    badge: 'Step 2',
  },
  {
    id: 'step-3',
    number: '03',
    icon: <Download size={20} strokeWidth={1.5} />,
    title: 'Save your file',
    desc: 'Select Download and look in your browser’s downloads when the file is ready.',
    badge: 'Step 3',
  },
];

const platforms = ['YouTube', 'Instagram', 'TikTok', 'SoundCloud', 'Twitch', 'Pinterest'];

export default function Home() {
  return (
    <>
      <FloatingNav />
      <main id="main-content">
        <HomeMotion />
        {/* ── Hero ── */}
        <Hero />

        {/* ── How It Works ── */}
        <section
          id="how-it-works"
          className="relative px-4 pt-8 pb-16 md:pt-12 md:pb-24 max-w-5xl mx-auto"
          aria-labelledby="how-it-works-title"
        >
          <div data-home-reveal className="text-center mb-10 md:mb-12">
            <h2
              id="how-it-works-title"
              className="text-3xl md:text-4xl font-semibold leading-tight tracking-tight"
            >
              How to download
            </h2>
          </div>

          <ol className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
            {steps.map((step) => (
              <li
                key={step.id}
                data-home-reveal
                className="rounded-2xl border border-line bg-panel p-5 flex flex-col gap-3"
                id={step.id}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="feature-icon-box bg-tint/[0.05] text-muted"
                    aria-hidden="true"
                  >
                    {step.icon}
                  </div>
                  <h3 className="min-w-0 flex-1 text-base font-bold text-ink leading-snug">{step.title}</h3>
                  <span className="font-mono text-lg text-muted select-none">
                    <span className="sr-only">{step.badge}</span>
                    <span aria-hidden="true">{step.number}</span>
                  </span>
                </div>

                <p className="text-sm leading-relaxed text-secondary">{step.desc}</p>
              </li>
            ))}
          </ol>

          {/* ── Platforms Strip ── */}
          <div className="mt-12">
            <p className="text-center text-sm font-medium text-muted mb-4">
              Examples of supported sites
            </p>
            <ul className="flex flex-wrap items-center justify-center gap-2">
              {platforms.map((name) => <li key={name} className="platform-chip">{name}</li>)}
            </ul>
          </div>
        </section>

        {/* ── Feature Bento ── */}
        <FeatureBento />

        {/* ── Bottom CTA Banner ── */}
        <section className="relative px-4 pt-4 pb-16 md:pt-8 md:pb-24">
          <div data-home-reveal className="max-w-3xl mx-auto rounded-3xl p-6 md:p-12 text-center bg-panel border border-line">
            <h2 className="text-balance text-3xl md:text-4xl font-bold text-ink mb-4">
              More download tools
            </h2>
            <p className="text-base mb-8 text-secondary">
              Find tools for website copies, audiobooks, book downloads and more.
            </p>
            <Link href="/advanced" className="btn-secondary inline-flex">
              Advanced tools <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </section>

        {/* ── Footer ── */}
        <Footer />
      </main>
    </>
  );
}
