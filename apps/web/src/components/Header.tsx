'use client';

import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { AlarmBadge } from './AlarmBadge';
import { Wordmark } from './Brand';
import { ConnectionChip } from './ConnectionChip';
import { useInstallPrompt, useOnline } from './hooks';
import { IconDownload } from './icons';
import { PlantSelect } from './PlantSelect';
import { UserLinks, UserMenu } from './UserMenu';

/**
 * Barra superior.
 * - `brand`: muestra el logotipo (cuando no hay barra lateral, o en móvil).
 * - `links`: enlaces de cuenta (escritorio sin barra lateral; con barra lateral viven en ella).
 * - `bare`: sin estado en vivo (pantallas sin planta).
 */
export function Header({ brand = true, links = true, bare }: { brand?: boolean; links?: boolean; bare?: boolean }) {
  const plantName = usePlantStore((s) => s.plants.find((p) => p.id === s.selected)?.name ?? s.selected);
  const multiple = usePlantStore((s) => s.plants.length > 1);
  const orgName = useSessionStore((s) => (s.me?.org ? s.me.org.name : s.me ? 'Campos Ingeniería' : null));
  const install = useInstallPrompt();
  const online = useOnline();

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line bg-surface px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
      <div className="flex min-w-0 items-center gap-3">
        {brand ? (
          <div className="min-w-0 leading-tight">
            <h1 className="m-0 md:hidden"><Wordmark className="text-2xl" /></h1>
            <p className="m-0 hidden md:block"><Wordmark className="text-2xl" /></p>
            {!bare && !multiple && plantName && <p className="truncate text-xs text-muted">{orgName ? `${orgName} · ` : ''}{plantName}</p>}
          </div>
        ) : (
          <p className="truncate text-sm text-muted">
            <span className="font-semibold text-fg">{orgName}</span>
            {!bare && !multiple && plantName ? ` · ${plantName}` : ''}
          </p>
        )}
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
        {!bare && <AlarmBadge href="/alarmas" />}
        {links && <UserLinks />}
        <UserMenu />
      </div>
      {!bare && <PlantSelect className="w-full sm:hidden" />}
    </header>
  );
}
