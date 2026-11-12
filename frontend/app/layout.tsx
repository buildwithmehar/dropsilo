import type { Metadata, Viewport } from 'next';
import './globals.css';
import { themeColors, themeScript } from '@/lib/theme';
import MotionPreferences from '@/components/MotionPreferences';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: themeColors.dark,
};

export const metadata: Metadata = {
  title: {
    default: 'DropSilo — Download videos, audio and files',
    template: '%s | DropSilo',
  },
  description:
    'Paste a public link to find and save videos, audio, photos and files. Choose from the available download options without signing up.',
  keywords: [
    'youtube downloader',
    'free video downloader',
    'download youtube video',
    'youtube to mp3',
    'save youtube video',
    'video downloader no account',
  ],
  authors: [{ name: 'DropSilo' }],
  creator: 'DropSilo',
  openGraph: {
    title: 'DropSilo — Download videos, audio and files',
    description:
      'Paste a public link and choose what to save.',
    type: 'website',
    locale: 'en_US',
    siteName: 'DropSilo',
  },
  twitter: {
    card: 'summary',
    title: 'DropSilo — Download videos, audio and files',
    description: 'Paste a public link and choose what to save.',
  },
  icons: {
    icon: [
      { url: '/favicon.png?v=dropsilo', type: 'image/png', sizes: '32x32' },
      { url: '/logo.svg?v=dropsilo', type: 'image/svg+xml', sizes: 'any' },
    ],
    apple: { url: '/apple-icon.png?v=dropsilo', sizes: '180x180', type: 'image/png' },
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&family=DM+Mono:wght@300;400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        {/* Skip to main content — accessibility */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-action focus:text-on-action focus:font-semibold focus:text-sm"
        >
          Skip to main content
        </a>

        {/* Main content */}
        <div className="relative z-10">
          <MotionPreferences>{children}</MotionPreferences>
        </div>
      </body>
    </html>
  );
}
