import type { Metadata } from 'next';
import AdvancedConsole from '@/components/AdvancedConsole';

export const metadata: Metadata = {
  title: 'Advanced downloads',
  robots: { index: false, follow: false },
};

export default function AdvancedPage() {
  return <AdvancedConsole />;
}
