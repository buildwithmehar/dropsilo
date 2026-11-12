'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { RefreshCw, ServerCrash, Home, Activity, ShieldAlert } from 'lucide-react';
import FloatingNav from '@/components/FloatingNav';
import Footer from '@/components/Footer';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled Server Exception:', error);
  }, [error]);

  return (
    <main className="min-h-screen bg-canvas text-ink flex flex-col justify-between overflow-x-clip selection:bg-rose-500/30">
      <FloatingNav />

      {/* Main Content Area */}
      <section className="relative pt-32 pb-20 px-4 flex-1 flex items-center justify-center">
        {/* Glowing red/rose accent orb */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[550px] h-[550px] bg-gradient-to-tr from-rose-600/15 via-purple-600/10 to-transparent rounded-full blur-[130px] pointer-events-none" />

        <div className="relative z-10 max-w-2xl mx-auto text-center space-y-8">
          {/* Animated Error Code Badge */}
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-rose-500/10 border border-rose-500/30 text-danger text-xs font-semibold tracking-wider uppercase backdrop-blur-md shadow-lg shadow-rose-500/10"
          >
            <ServerCrash size={14} className="text-danger" />
            <span>HTTP 500 / 505 — Internal Engine Exception</span>
          </motion.div>

          {/* Title */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="space-y-4"
          >
            <h1 className="text-6xl sm:text-8xl font-black tracking-tight text-ink">
              500 Error
            </h1>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink">
              Extraction Processing Interrupted
            </h2>
            <p className="text-base sm:text-lg text-muted max-w-lg mx-auto leading-relaxed">
              An unexpected upstream error or stream mismatch occurred while communicating with the YouTube node cluster.
            </p>
          </motion.div>

          {/* Action Buttons */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4"
          >
            <button
              onClick={() => reset()}
              className="btn-primary justify-center w-full sm:w-auto"
            >
              <RefreshCw size={18} />
              <span>Retry Engine Task</span>
            </button>

            <Link
              href="/status"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-2xl bg-tint/[0.05] border border-tint/[0.1] text-secondary hover:text-ink hover:bg-tint/[0.08] hover:border-tint/[0.2] font-semibold text-sm transition-colors duration-200"
            >
              <Activity size={18} className="text-success" />
              <span>Check System Status</span>
            </Link>
          </motion.div>

          {/* Error Digest Technical Console Box */}
          {error.digest && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              className="p-4 rounded-xl bg-black/50 border border-tint/[0.1] text-left font-mono text-xs space-y-1 text-muted"
            >
              <div className="flex items-center justify-between text-muted mb-2 border-b border-tint/[0.05] pb-2">
                <span className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-[10px]">
                  <ShieldAlert size={12} className="text-danger" /> Diagnostic Digest
                </span>
                <span>ID: {error.digest}</span>
              </div>
              <p className="text-danger font-medium">{error.message || 'Unknown stream node execution anomaly.'}</p>
            </motion.div>
          )}
        </div>
      </section>

      <Footer />
    </main>
  );
}
