'use client';

import { usePlantStore } from '@/store/plant-store';
import { AlarmBadge } from './AlarmBadge';
import { ConnectionChip } from './ConnectionChip';
import { IconDownload } from './icons';
import { useInstallPrompt, useOnline } from './hooks';
import { PlantSelect } from './PlantSelect';
import { UserLinks, UserMenu } from './UserMenu';

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#38bdf8" />
      <path d="M8 21V11l8-4 8 4v10l-8 4-8-4Z" fill="none" stroke="#0a0e13" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M8 11l8 4 8-4M16 15v10" stroke="#0a0e13" strokeWidth="2.4" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** `bare`: sin estado en vivo (alarmas, conexión, selector); para pantallas sin planta. */
export function Header({ onAlarmsClick, bare }: { onAlarmsClick?: () => void; bare?: boolean }) {
  const plantName = usePlantStore((s) => s.plants.find((p) => p.id === s.selected)?.name ?? s.selected);
  const multiple = usePlantStore((s) => s.plants.length > 1);
  const install = useInstallPrompt();
  const online = useOnline();

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line bg-surface px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
      <div className="flex min-w-0 items-center gap-3">
        <Logo />
        <div className="min-w-0 leading-tight">
          <h1 className="text-lg font-bold tracking-tight">Campo</h1>
          {!bare && !multiple && plantName && <p className="truncate text-xs text-muted">Planta {plantName}</p>}
        </div>
        {!bare && <PlantSelect className="hidden sm:flex" />}
      </div>
      <div className="flex items-center gap-2">
        {!bare && <ConnectionChip />}
        {install && online && (
          <button
            type="button"
            onClick={() => void install()}
            className="hidden min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface-2 sm:inline-flex"
          >
            <IconDownload className="text-base" /> Instalar
          </button>
        )}
        {!bare && <AlarmBadge onClick={onAlarmsClick} />}
        <UserLinks />
        <UserMenu />
      </div>
      {!bare && <PlantSelect className="w-full sm:hidden" />}
    </header>
  );
}
