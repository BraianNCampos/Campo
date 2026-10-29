'use client';

import { useLiveStore } from '@/store/live-store';
import { IconCube, IconOffline, IconWifi, IconWarning, IconCritical } from './icons';
import { useOnline } from './hooks';

/** Estado de conexión: demo / en línea / reconectando / sin red / sesión caducada. */
export function ConnectionChip() {
  const mode = useLiveStore((s) => s.mode);
  const connection = useLiveStore((s) => s.connection);
  const attempt = useLiveStore((s) => s.attempt);
  const fromCache = useLiveStore((s) => s.fromCache);
  const online = useOnline();

  let label: string;
  let cls: string;
  let Icon = IconWifi;
  if (!online) {
    label = 'Sin conexión';
    cls = 'text-warn border-warn/70 bg-warn/15';
    Icon = IconOffline;
  } else if (mode === 'mock') {
    label = 'Demo';
    cls = 'text-accent border-accent/60 bg-accent/15';
    Icon = IconCube;
  } else if (connection === 'open') {
    label = fromCache ? 'En línea (caché)' : 'En línea';
    cls = 'text-ok border-ok/60 bg-ok/15';
  } else if (connection === 'unauthorized') {
    label = 'Sesión caducada';
    cls = 'text-crit border-crit/70 bg-crit/15';
    Icon = IconCritical;
  } else {
    label = attempt > 0 ? `Reconectando (${attempt})` : 'Conectando';
    cls = 'text-warn border-warn/70 bg-warn/15';
    Icon = IconWarning;
  }
  return (
    <span
      role="status"
      data-testid="connection-chip"
      className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold ${cls}`}
    >
      <Icon className="text-base" />
      {label}
      {fromCache && online && mode === 'live' && connection !== 'open' && <span className="sr-only"> datos de caché</span>}
    </span>
  );
}
