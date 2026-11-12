'use client';

import { useEffect } from 'react';

export default function HomeMotion() {
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute('data-revealed', '');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -32px 0px' });

    document.querySelectorAll('[data-home-reveal]').forEach((element) => {
      // Content already on screen stays in place on reload and back navigation.
      if (element.getBoundingClientRect().top >= window.innerHeight) observer.observe(element);
    });

    return () => observer.disconnect();
  }, []);

  return null;
}
