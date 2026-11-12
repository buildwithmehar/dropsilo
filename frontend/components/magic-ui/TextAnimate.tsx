'use client';

import { motion, type Variants } from 'framer-motion';

// Adapted from https://magicui.design/docs/components/text-animate (MIT).
const container: Variants = {
  show: { transition: { staggerChildren: 0.09 } },
};

const segment: Variants = {
  hidden: { opacity: 0.42, y: 14, filter: 'blur(2px)' },
  show: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.52, ease: [0.22, 1, 0.36, 1] },
  },
};

interface TextAnimateProps {
  lines: readonly { text: string; className?: string }[];
}

export default function TextAnimate({ lines }: TextAnimateProps) {
  return (
    <motion.span
      aria-hidden="true"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {lines.map((line) => (
        <motion.span
          key={line.text}
          className={`magic-text-line ${line.className ?? ''}`}
          variants={segment}
        >
          {line.text}
        </motion.span>
      ))}
    </motion.span>
  );
}
