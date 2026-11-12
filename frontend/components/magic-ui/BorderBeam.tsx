'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

// Adapted from https://magicui.design/docs/components/border-beam (MIT).
export default function BorderBeam({ busy, pass }: { busy: boolean; pass: number }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setEnabled(!preference.matches);
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  if (!enabled) return null;

  return (
    <div className="magic-border-beam" aria-hidden="true">
      <motion.div
        key={busy ? 'busy' : pass}
        className="magic-border-beam-light"
        initial={{ offsetDistance: '0%', opacity: 0 }}
        animate={{ offsetDistance: '100%', opacity: busy ? 1 : [0, 1, 1, 0] }}
        transition={{
          offsetDistance: { duration: busy ? 2.4 : 1.85, ease: 'linear', repeat: busy ? Infinity : 0 },
          opacity: { duration: busy ? 0.18 : 1.85, times: busy ? undefined : [0, 0.13, 0.84, 1] },
        }}
      />
    </div>
  );
}
