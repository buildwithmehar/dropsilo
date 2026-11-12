export const themeStorageKey = 'easysave-theme';

export const themeColors = {
  dark: '#030307',
  light: '#f7f6fa',
} as const;

export type Theme = keyof typeof themeColors;

export const themeScript = `
  (() => {
    try {
      const saved = localStorage.getItem(${JSON.stringify(themeStorageKey)});
      if (saved === 'light' || saved === 'dark') {
        document.documentElement.dataset.theme = saved;
        document.querySelector('meta[name="theme-color"]')?.setAttribute(
          'content',
          ${JSON.stringify(themeColors)}[saved]
        );
      }
    } catch {}
  })();
`;
