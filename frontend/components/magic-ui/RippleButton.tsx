'use client';

import { useRef, useState, type ComponentPropsWithoutRef, type PointerEvent } from 'react';
import { useReducedMotion } from 'framer-motion';

type Ripple = { id: number; x: number; y: number; size: number };

// Adapted from https://magicui.design/docs/components/ripple-button (MIT).
export default function RippleButton({
  children,
  className,
  onPointerDown,
  ...props
}: ComponentPropsWithoutRef<'button'>) {
  const [ripple, setRipple] = useState<Ripple | null>(null);
  const nextId = useRef(0);
  const reduceMotion = useReducedMotion();

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    onPointerDown?.(event);
    if (event.defaultPrevented || event.button !== 0 || reduceMotion || props.disabled) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const size = 2 * Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
    setRipple({ id: nextId.current++, x, y, size });
  }

  return (
    <button {...props} className={`magic-ripple-button ${className ?? ''}`} onPointerDown={handlePointerDown}>
      {children}
      {ripple && (
        <span className="magic-ripple-clip" aria-hidden="true">
          <span
            key={ripple.id}
            className="magic-ripple-wave"
            style={{
              left: ripple.x - ripple.size / 2,
              top: ripple.y - ripple.size / 2,
              width: ripple.size,
              height: ripple.size,
            }}
            onAnimationEnd={() => setRipple((current) => current?.id === ripple.id ? null : current)}
          />
        </span>
      )}
    </button>
  );
}
