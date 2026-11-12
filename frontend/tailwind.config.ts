import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['Plus Jakarta Sans', 'sans-serif'],
        mono: ['DM Mono', 'monospace'],
        body: ['Plus Jakarta Sans', 'sans-serif'],
      },
      colors: {
        canvas: 'var(--color-dark)',
        panel: 'var(--color-card)',
        ink: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        muted: 'var(--text-muted)',
        line: 'var(--color-border)',
        tint: 'rgb(var(--ui-tint) / <alpha-value>)',
        accent: 'var(--accent-text)',
        action: 'var(--action)',
        'action-hover': 'var(--action-hover)',
        'accent-soft': 'var(--accent-soft)',
        'on-action': 'var(--on-action)',
        info: 'var(--info-text)',
        success: 'var(--success-text)',
        danger: 'var(--danger-text)',
        warning: 'var(--warning-text)',
        brand: {
          rose: '#E11D48',
          violet: '#8B5CF6',
          cyan: '#06B6D4',
          dark: '#050505',
          darker: '#030303',
          card: '#0D0D0F',
          border: 'rgba(255,255,255,0.06)',
          'border-hover': 'rgba(255,255,255,0.12)',
        },
      },
      backgroundImage: {
        'mesh-violet': 'radial-gradient(ellipse at 20% 50%, rgba(139,92,246,0.15) 0%, transparent 60%)',
        'mesh-cyan': 'radial-gradient(ellipse at 80% 20%, rgba(6,182,212,0.12) 0%, transparent 60%)',
        'mesh-rose': 'radial-gradient(ellipse at 50% 80%, rgba(225,29,72,0.10) 0%, transparent 60%)',
        'glass-card': 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%)',
        'cta-gradient': 'linear-gradient(135deg, #8B5CF6 0%, #E11D48 100%)',
        'glow-cyan': 'radial-gradient(circle at center, rgba(6,182,212,0.3) 0%, transparent 70%)',
      },
      boxShadow: {
        'glass': '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)',
        'glass-hover': '0 16px 48px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.12)',
        'glow-violet': '0 0 40px rgba(139,92,246,0.3)',
        'glow-cyan': '0 0 40px rgba(6,182,212,0.25)',
        'glow-rose': '0 0 40px rgba(225,29,72,0.25)',
        'inner-highlight': 'inset 0 1px 1px rgba(255,255,255,0.1)',
      },
      keyframes: {
        'float': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '0.4', transform: 'scale(1)' },
          '50%': { opacity: '0.8', transform: 'scale(1.05)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'spin-slow': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        'scan-line': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
      },
      animation: {
        'float': 'float 3s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'shimmer': 'shimmer 2.5s linear infinite',
        'spin-slow': 'spin-slow 8s linear infinite',
        'scan-line': 'scan-line 4s linear infinite',
      },
      backdropBlur: {
        'xs': '4px',
      },
      transitionTimingFunction: {
        'expo-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'expo-in-out': 'cubic-bezier(0.87, 0, 0.13, 1)',
        'spring': 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      borderRadius: {
        '4xl': '2rem',
        '5xl': '2.5rem',
      },
    },
  },
  plugins: [],
};

export default config;
