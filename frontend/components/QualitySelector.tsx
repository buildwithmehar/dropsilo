'use client';

import { ChevronDown } from 'lucide-react';

export interface QualityItem {
  id: string;
  height: number;
  fps?: number;
  isHdr?: boolean;
  vcodec?: string;
  acodec?: string;
  label: string;
  type: 'standard' | 'dash';
  streamType?: 'progressive' | 'dash';
  requiresMerge?: boolean;
  canDirectDownload?: boolean;
  mergeReason?: string;
  ext: string;
  url?: string;
  video_url?: string;
  audio_url?: string;
  note?: string;
  size?: number;
  formattedSize?: string;
  format_id: string;
}

interface Props {
  id: string;
  label: string;
  options: { value: string; label: string }[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export default function QualitySelector({ id, label, options, value, disabled, onChange }: Props) {
  return (
    <div className="min-w-0">
      <label className="download-field-label" htmlFor={id}>{label}</label>
      <div className="relative">
        <select
          id={id}
          className="download-select"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <ChevronDown className="download-select-icon" size={16} aria-hidden="true" />
      </div>
    </div>
  );
}
