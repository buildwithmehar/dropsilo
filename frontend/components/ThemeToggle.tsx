'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { themeColors, themeStorageKey, type Theme } from '@/lib/theme';

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColors[theme]);
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const initial = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    setTheme(initial);
    applyTheme(initial);

    const sync = (event: StorageEvent) => {
      if (event.key !== themeStorageKey && event.key !== null) return;
      const next = event.newValue === 'light' ? 'light' : 'dark';
      setTheme(next);
      applyTheme(next);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    setTheme(next);
    try {
      localStorage.setItem(themeStorageKey, next);
    } catch {
      // The toggle still works for this visit when storage is unavailable.
    }
  }

  return (
    <button
      type="button"
      className="nav-icon-button theme-toggle"
      onClick={toggleTheme}
      aria-label="Light mode"
      aria-pressed={theme === 'light'}
      title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
    >
      <span className="icon-swap" aria-hidden="true">
        <Sun size={18} />
        <Moon size={18} />
      </span>
    </button>
  );
}
