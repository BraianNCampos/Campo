'use client';

import { IconOffline } from './icons';
import { useOnline } from './hooks';

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="flex items-center justify-center gap-2 border-b border-warn/70 bg-warn/15 px-4 py-2 text-sm font-semibold text-warn">
      <IconOffline className="text-lg" />
      Sin conexión: se muestra el último estado conocido.
    </div>
  );
}
