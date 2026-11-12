import type { Metadata } from 'next';
import InfoPage from '@/components/InfoPage';

export const metadata: Metadata = {
  title: 'Copyright requests',
  description: 'How to submit a copyright request about a link used with DropSilo.',
};

const noticeDetails = [
  'Your name and physical or electronic signature.',
  'A description of the copyrighted work.',
  'The specific link or links you are reporting.',
  'Your email, phone number and mailing address.',
  'A statement that you have a good faith belief the use is unauthorized.',
  'A statement, under penalty of perjury, that the information is accurate and you are authorized to act for the copyright owner.',
];

export default function DmcaPage() {
  return (
    <InfoPage title="Copyright requests" description="Copyright owners and authorized representatives can report a link used with DropSilo.">
      <section className="rounded-2xl border border-line bg-panel p-5 sm:p-6">
        <h2 className="font-semibold text-ink">What to include</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-secondary">
          {noticeDetails.map((detail) => <li key={detail}>{detail}</li>)}
        </ol>
        <a href="mailto:dmca@easysave.app" className="btn-secondary mt-5">Email dmca@easysave.app</a>
      </section>
    </InfoPage>
  );
}
