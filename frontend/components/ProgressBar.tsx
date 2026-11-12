'use client';

import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

interface Props {
  progress?: number;
  stage: string;
  speedMbps?: string;
  etaSeconds?: string;
  downloadedSize?: string;
  totalSize?: string;
  isVisible: boolean;
  action?: ReactNode;
}

const stages: Record<string, string> = {
  starting: 'Starting download…',
  queued: 'Waiting to start…',
  downloading: 'Getting your file…',
  processing: 'Processing your file…',
  finalizing: 'Finishing up…',
  packaging: 'Packing photos into a ZIP…',
  reconnecting: 'Reconnecting…',
  stopping: 'Stopping download…',
};

export default function ProgressBar({ progress, stage, speedMbps, etaSeconds, downloadedSize, totalSize, isVisible, action }: Props) {
  const reduceMotion = useReducedMotion();
  const percent = progress != null && progress > 0 ? Math.min(100, Math.round(progress)) : undefined;
  const metrics = [
    speedMbps,
    [downloadedSize, totalSize].filter(Boolean).join(' / '),
    speedMbps && etaSeconds && etaSeconds !== 'Unknown' ? `About ${etaSeconds} left` : '',
  ].filter(Boolean);
  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.18 }}
          className="space-y-2.5 rounded-xl border border-line px-3.5 py-3"
        >
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium text-ink" role="status">{stages[stage] || stages.starting}</span>
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              {percent !== undefined && <span className="tabular-nums text-secondary">{percent}%</span>}
              {action}
            </div>
          </div>
          <div className="progress-track" role="progressbar" aria-label="Download progress" aria-valuenow={percent}>
            <div className="progress-fill" data-indeterminate={percent === undefined}
              style={percent === undefined ? undefined : { transform: `scaleX(${percent / 100})` }} />
          </div>
          {metrics.length > 0 && stage !== 'reconnecting' && stage !== 'stopping' && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted">
              {metrics.map((metric) => <span key={metric}>{metric}</span>)}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
