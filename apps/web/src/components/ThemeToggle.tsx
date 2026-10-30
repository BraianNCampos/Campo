'use client';

import { useSyncExternalStore } from 'react';
import { applyTheme, nextTheme, type Theme } from '@/lib/theme';
import { IconSun } from './icons';

const listeners = new Set<() => void>();
const current = (): Theme => (document.documentElement.getAttribute('data-theme') === 'contrast' ? 'contrast' : 'dark');
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** Interruptor del modo de alto contraste (luz solar). `variant="menu"` se ve como un ítem de menú. */
export function ThemeToggle({ variant = 'menu', className = '' }: { variant?: 'menu' | 'button'; className?: string }) {
  const theme = useSyncExternalStore(subscribe, current, () => 'dark' as Theme);
  const on = theme === 'contrast';
  const base =
    variant === 'menu'
      ? 'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-semibold hover:bg-surface-2'
      : 'inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface-2';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-testid="theme-toggle"
      onClick={() => {
        applyTheme(nextTheme(theme));
        listeners.forEach((l) => l());
      }}
      className={`${base} ${className}`}
    >
      <IconSun className={variant === 'menu' ? 'shrink-0 text-xl' : 'text-base'} />
      <span className={variant === 'menu' ? 'flex-1' : ''}>{variant === 'menu' ? 'Alto contraste (luz solar)' : 'Alto contraste'}</span>
      <span className="font-mono text-xs text-muted">{on ? 'Sí' : 'No'}</span>
    </button>
  );
}
