'use client';

import { useLiveStore } from '@/store/live-store';
import { IconGrid } from './icons';

/** Sin activos que mostrar (ni en el catálogo ni con telemetría): explica por qué. */
export function EmptyAssets({ className = '' }: { className?: string }) {
  const ready = useLiveStore((s) => s.catalogReady);
  const failed = useLiveStore((s) => s.catalogError);
  const text = ready
    ? 'Esta planta todavía no tiene activos en el catálogo. Cargalos en Administración › Plantas y activos.'
    : failed
      ? 'No pudimos cargar el catálogo de activos. Mientras tanto, vas a ver los equipos que envíen datos.'
      : 'Cargando activos…';
  return (
    <div role="status" data-testid="empty-assets" className={`flex flex-col items-center gap-2 px-3 py-6 text-center text-sm text-muted ${className}`}>
      <IconGrid className="text-3xl" />
      <p>{text}</p>
    </div>
  );
}
