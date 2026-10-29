'use client';

import { useRouter } from 'next/navigation';
import { clearToken, getToken } from '@/lib/auth';
import { config } from '@/lib/env';
import { useLiveStore } from '@/store/live-store';
import { AlarmBadge } from './AlarmBadge';
import { ConnectionChip } from './ConnectionChip';
import { IconDownload, IconLogout } from './icons';
import { useInstallPrompt, useOnline } from './hooks';

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#38bdf8" />
      <path d="M8 21V11l8-4 8 4v10l-8 4-8-4Z" fill="none" stroke="#0a0e13" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M8 11l8 4 8-4M16 15v10" stroke="#0a0e13" strokeWidth="2.4" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function Header({ onAlarmsClick }: { onAlarmsClick?: () => void }) {
  const plant = useLiveStore((s) => s.plant);
  const install = useInstallPrompt();
  const router = useRouter();
  const online = useOnline();
  const showLogout = !config.mock && getToken();

  return (
    <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
      <div className="flex min-w-0 items-center gap-3">
        <Logo />
        <div className="min-w-0 leading-tight">
          <h1 className="text-lg font-bold tracking-tight">Campo</h1>
          <p className="truncate text-xs text-muted">
            Planta <span className="font-mono">{plant}</span>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ConnectionChip />
        {install && online && (
          <button
            type="button"
            onClick={() => void install()}
            className="hidden min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface-2 sm:inline-flex"
          >
            <IconDownload className="text-base" /> Instalar
          </button>
        )}
        <AlarmBadge onClick={onAlarmsClick} />
        {showLogout && (
          <button
            type="button"
            aria-label="Cerrar sesión"
            onClick={() => {
              clearToken();
              router.replace('/login');
            }}
            className="flex size-11 items-center justify-center rounded-lg border border-line text-xl hover:bg-surface-2"
          >
            <IconLogout />
          </button>
        )}
      </div>
    </header>
  );
}
