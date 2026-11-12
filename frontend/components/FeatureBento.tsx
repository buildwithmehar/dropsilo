import { AudioLines, FileDown, Images, ListVideo, Radio, Video } from 'lucide-react';

const features = [
  { icon: Video, title: 'Video', text: 'Choose from the video qualities available for your link.' },
  { icon: AudioLines, title: 'Audio', text: 'Save just the audio when your link has that option.' },
  { icon: Images, title: 'Photo galleries', text: 'Save one photo or download several together in a ZIP file.' },
  { icon: ListVideo, title: 'Playlists', text: 'Pick the items you want and save them together.' },
  { icon: Radio, title: 'Live streams', text: 'Save a short recording from a supported public stream.' },
  { icon: FileDown, title: 'Direct files', text: 'Save PDFs, e-books and other supported files in their original format.' },
];

export function DownloadTypes() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {features.map(({ icon: Icon, title, text }) => (
        <li key={title} className="flex items-start gap-3 rounded-2xl border border-line bg-panel p-5">
          <Icon className="mt-0.5 shrink-0 text-muted" size={18} strokeWidth={1.75} aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="font-semibold text-ink">{title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-secondary">{text}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function FeatureBento() {
  return (
    <section id="features" className="mx-auto max-w-5xl px-4 pb-16 md:pb-24" aria-labelledby="download-types">
      <h2 id="download-types" className="mb-6 text-center text-3xl font-semibold tracking-tight md:mb-8 md:text-4xl">
        What you can save
      </h2>
      <DownloadTypes />
    </section>
  );
}
