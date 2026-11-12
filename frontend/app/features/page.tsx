import Link from 'next/link';
import { DownloadTypes } from '@/components/FeatureBento';
import InfoPage from '@/components/InfoPage';

export default function FeaturesPage() {
  return (
    <InfoPage title="What you can download" description="DropSilo checks each public link and shows the options it finds. Formats and quality depend on the source.">
      <DownloadTypes />
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <Link href="/#video-url-input" className="btn-primary">Try a link</Link>
        <Link href="/advanced" className="btn-secondary">Advanced tools</Link>
      </div>
    </InfoPage>
  );
}
