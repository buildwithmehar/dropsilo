import type { ReactNode } from 'react';
import FloatingNav from './FloatingNav';
import Footer from './Footer';

export default function InfoPage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <FloatingNav />
      <main id="main-content" className="mx-auto w-full max-w-4xl flex-1 px-5 pb-16 pt-28 sm:px-8 sm:pb-24 sm:pt-36">
        <header className="mb-8 max-w-xl sm:mb-10">
          <h1 className="break-words text-4xl font-semibold tracking-tight text-ink sm:text-5xl">{title}</h1>
          <p className="mt-4 leading-relaxed text-secondary">{description}</p>
        </header>
        {children}
      </main>
      <Footer />
    </div>
  );
}
