'use client';

import { useState, useEffect, useRef } from 'react';
import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Logo from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';

const navLinks = [
  { label: 'Download', href: '/' },
  { label: 'Features', href: '/features' },
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Help', href: '/faq' },
  { label: 'Advanced', href: '/advanced' },
];

export default function FloatingNav() {
  const [isOpen, setIsOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      menuButton.current?.focus();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isOpen]);

  return (
    <>
      <nav
        className="fixed top-5 left-0 right-0 z-50 flex justify-center pointer-events-none px-4"
        role="navigation"
        aria-label="Main navigation"
      >
        <div
          className="nav-shell pointer-events-auto flex items-center gap-1 px-2 py-1 rounded-full"
          data-scrolled={scrolled}
        >
          {/* Logo */}
          <Link
            href="/"
            className="flex min-h-11 items-center px-2 rounded-full transition-opacity duration-200 hover:opacity-85"
            aria-label="DropSilo Home"
          >
            <Logo size={28} showText={true} />
          </Link>

          {/* Divider */}
          <div className="hidden md:block w-px h-4 bg-line mx-1" aria-hidden="true" />

          {/* Desktop Links */}
          <div className="hidden md:flex items-center gap-0.5">
            {navLinks.map((link) => {
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.label}
                  href={link.href}
                  className={`nav-link ${isActive ? 'text-accent' : 'text-muted hover:text-ink'}`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>

          <div className="w-px h-4 bg-line mx-1" aria-hidden="true" />
          <ThemeToggle />
          <button
            ref={menuButton}
            type="button"
            onClick={() => setIsOpen((v) => !v)}
            aria-label={isOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={isOpen}
            aria-controls="mobile-nav"
            className="nav-icon-button md:hidden"
          >
            <span className="icon-swap" data-swap={isOpen} aria-hidden="true">
              <Menu size={18} />
              <X size={18} />
            </span>
          </button>
        </div>
      </nav>

      <div
        className="mobile-nav-backdrop fixed inset-0 z-40 md:hidden"
        data-open={isOpen}
        onClick={() => setIsOpen(false)}
        aria-hidden="true"
      />
      <nav
        id="mobile-nav"
        className="mobile-nav fixed inset-x-4 z-[45] mx-auto max-w-sm md:hidden"
        aria-label="Mobile navigation"
        aria-hidden={!isOpen}
      >
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            onClick={() => setIsOpen(false)}
            tabIndex={isOpen ? undefined : -1}
            className="nav-link"
            aria-current={pathname === link.href ? 'page' : undefined}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
