'use client';

import { useEffect } from 'react';
import { MODULES } from '@campo/shared';
import { usePlantStore } from '@/store/plant-store';
import { useLiveStore } from '@/store/live-store';
import { ToastRegion } from '../admin/ToastRegion';
import { HexPattern } from '../HexPattern';
import { IconControl, IconInfo } from '../icons';
import { OrderLog } from './OrderLog';
import { TankControlCard } from './TankControlCard';
import { useControllableIds } from './useControlData';

const def = MODULES.find((m) => m.id === 'control')!;

/** `/m/control`: Control de llenado (docs §14.3). Cada orden pasa por vista previa y confirmación; el servidor decide los enclavamientos. */
export function ControlScreen() {
  const plant = usePlantStore((s) => s.selected) ?? '';
  const plantName = usePlantStore((s) => s.plants.find((p) => p.id === s.selected)?.name);
  const catalogReady = useLiveStore((s) => s.catalogReady);
  const { enabled, disabled } = useControllableIds();

  useEffect(() => {
    document.title = `${def.label} · Campo`;
  }, []);

  return (
    <div data-testid="module-screen" data-module="control" className="min-h-full">
      <header className="relative overflow-hidden border-b border-line">
        <div className="hidden md:block"><HexPattern /></div>
        <div className="relative mx-auto max-w-[1600px] px-4 py-5 md:px-6 md:py-6">
          <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-muted uppercase">
            <IconControl className="text-base" /> {plantName ?? 'Planta'}
          </p>
          <h1 className="mt-1 text-[26px] leading-tight font-extrabold tracking-tight md:text-3xl">{def.label}</h1>
          <p className="mt-0.5 text-sm text-muted">{def.description}</p>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1600px] flex-col gap-8 px-4 py-5 md:px-6">
        <section aria-label="Tanques y silos" className="flex flex-col gap-3">
          <p className="flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">
            <IconInfo className="mt-0.5 shrink-0 text-base" />
            Cada orden se revisa antes de ejecutarse: vas a ver un resumen y tenés 60 segundos para confirmarla. «Detener» está siempre disponible.
          </p>
          {enabled.length === 0 ? (
            <div role="status" data-testid="control-empty" className="mx-auto flex max-w-md flex-col items-center gap-2 px-4 py-12 text-center">
              <IconControl className="text-4xl text-muted" />
              <p className="text-lg font-bold">{catalogReady ? 'Ningún tanque está habilitado para control' : 'Cargando equipos…'}</p>
              {catalogReady && (
                <p className="text-sm text-muted">
                  Un ingeniero o administrador tiene que habilitar el control de llenado de cada tanque o silo en Administración, dentro de «Plantas y activos».
                </p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 min-[700px]:grid-cols-2 min-[1200px]:grid-cols-3 min-[1700px]:grid-cols-4">
              {enabled.map((id) => (
                <TankControlCard key={id} id={id} plant={plant} />
              ))}
            </div>
          )}
          {enabled.length > 0 && disabled.length > 0 && (
            <p data-testid="control-disabled-note" className="text-sm text-muted">
              {disabled.length === 1 ? '1 tanque o silo más no está habilitado' : `${disabled.length} tanques o silos más no están habilitados`} para recibir órdenes (se habilita en Administración).
            </p>
          )}
        </section>
        <OrderLog />
      </div>
      <ToastRegion />
    </div>
  );
}
