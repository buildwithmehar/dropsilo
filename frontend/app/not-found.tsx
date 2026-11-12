'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Home, HelpCircle, AlertCircle, ArrowRight } from 'lucide-react';
import FloatingNav from '@/components/FloatingNav';
import Footer from '@/components/Footer';

export default function NotFound() {
  return (
    <main className="min-h-screen bg-canvas text-ink flex flex-col justify-between overflow-x-clip selection:bg-purple-500/30">
      <FloatingNav />

      {/* Main Content Area */}
      <section className="relative pt-32 pb-20 px-4 flex-1 flex items-center justify-center">
        {/* Background glow orb */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-gradient-to-tr from-violet-600/20 via-cyan-500/10 to-transparent rounded-full blur-[120px] pointer-events-none" />

        <div className="relative z-10 max-w-2xl mx-auto text-center space-y-8">
          {/* Animated Error Code Badge */}
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/30 text-accent text-xs font-semibold tracking-wider uppercase backdrop-blur-md shadow-lg shadow-violet-500/10"
          >
            <AlertCircle size={14} className="text-accent" />
            <span>Error 404 — Page Not Found</span>
          </motion.div>

          {/* Large Hero Title */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="space-y-4"
          >
            <h1 className="text-7xl sm:text-9xl font-black tracking-tight text-ink">
              404
            </h1>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink">
              Lost in the Digital Ether
            </h2>
            <p className="text-base sm:text-lg text-muted max-w-lg mx-auto leading-relaxed">
              The page or video endpoint you are looking for has been moved, deleted, or never existed in our node mesh.
            </p>
          </motion.div>

          {/* Action Buttons & Quick Nav */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4"
          >
            <Link
              href="/"
              className="btn-primary justify-center w-full sm:w-auto"
            >
              <Home size={18} />
              <span>Back to Downloader</span>
            </Link>

            <Link
              href="/faq"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-2xl bg-tint/[0.05] border border-tint/[0.1] text-secondary hover:text-ink hover:bg-tint/[0.08] hover:border-tint/[0.2] font-semibold text-sm transition-colors duration-200"
            >
              <HelpCircle size={18} />
              <span>Visit Help Center</span>
            </Link>
          </motion.div>

          {/* Quick Suggestions Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="pt-8 grid grid-cols-1 sm:grid-cols-3 gap-3 text-left"
          >
            {[
              { href: '/', title: 'Video Converter', desc: 'Download 4K & MP3' },
              { href: '/features', title: 'Platform Features', desc: 'Explore capabilities' },
              { href: '/status', title: 'System Status', desc: 'Check network nodes' },
            ].map((item) => (
              <Link
                key={item.title}
                href={item.href}
                className="group p-4 rounded-xl bg-tint/[0.03] border border-tint/[0.06] hover:bg-tint/[0.06] hover:border-violet-500/30 transition-colors duration-200"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-ink group-hover:text-accent transition-colors">
                    {item.title}
                  </span>
                  <ArrowRight size={14} className="text-muted group-hover:text-accent group-hover:translate-x-1 transition-colors" />
                </div>
                <p className="text-xs text-muted mt-1">{item.desc}</p>
              </Link>
            ))}
          </motion.div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
