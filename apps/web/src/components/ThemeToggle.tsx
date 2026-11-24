'use client';

import { useEffect } from 'react';

const STORAGE_KEY = 'color-scheme';

function getSystemScheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncMeta(val: string | null) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) {
    meta.content = val === 'light' || val === 'dark' ? val : 'light dark';
  }
}

export function ThemeToggle() {
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        syncMeta(event.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const handleToggle = () => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      stored = null;
    }

    const system = getSystemScheme();
    const currentlyRendered = stored === 'light' || stored === 'dark' ? stored : system;
    const target = currentlyRendered === 'dark' ? 'light' : 'dark';

    // Remove override when returning to current system preference
    const nextValue = target === system ? null : target;
    try {
      if (nextValue === null) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, nextValue);
      }
    } catch {
      // Ignore storage errors and still apply to <meta>
    }
    syncMeta(nextValue);
  };

  return (
    <button
      type="button"
      className="btn theme-toggle-btn"
      onClick={handleToggle}
      title="Toggle between Prasanthi Dawn (Light) and Mandir Sandhya (Dark)"
    >
      <span className="label-when-light">Mandir Sandhya (Dark)</span>
      <span className="label-when-dark">Prasanthi Dawn (Light)</span>
    </button>
  );
}
