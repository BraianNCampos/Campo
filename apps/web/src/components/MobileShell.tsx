'use client';

import { useState } from 'react';
import { useLiveStore } from '@/store/live-store';
import { useUiStore } from '@/store/ui-store';
import { AssetCard } from './AssetCard';
import { AssetPanel } from './AssetPanel';
import { EmptyAssets } from './EmptyAssets';
import { IconCube } from './icons';
import { PlantView } from './PlantView';

/** Módulo «Vista 3D», móvil: resumen de activos y 3D bajo demanda (no se monta ningún Canvas por defecto). */
export function MobileShell() {
  const [tab, setTab] = useState<'summary' | '3d'>('summary');
  const [want3d, setWant3d] = useState(false);
  const ids = useLiveStore((s) => s.assetIds);
  const selectedId = useUiStore((s) => s.selectedId);

  return (
    <div className="flex min-h-full flex-col">
      <div role="tablist" aria-label="Vista" className="flex gap-1 border-b border-line px-3">
        {([['summary', 'Resumen'], ['3d', '3D']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`tab-${id}`}
            onClick={() => setTab(id)}
            className={`min-h-11 border-b-2 px-4 text-sm font-semibold ${tab === id ? 'border-fg text-fg' : 'border-transparent text-muted'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'summary' && (
        <section aria-label="Resumen de activos" className="grid grid-cols-1 gap-3 p-3 min-[600px]:grid-cols-2">
          {ids.length === 0 && <EmptyAssets className="min-[600px]:col-span-2" />}
          {ids.map((id) => (
            <AssetCard key={id} id={id} />
          ))}
        </section>
      )}
      {tab === '3d' && (
        <section aria-label="Gemelo digital 3D" className="flex min-h-[28rem] flex-1 flex-col p-3">
          {!want3d ? (
            <div className="m-auto flex max-w-xs flex-col items-center gap-4 text-center">
              <IconCube className="text-6xl text-muted" />
              <p className="text-lg font-bold">Gemelo digital 3D</p>
              <p className="text-sm text-muted">La vista 3D gasta más batería y datos, por eso no se carga sola. Cargala cuando la necesites.</p>
              <button type="button" onClick={() => setWant3d(true)} className="min-h-12 w-full rounded-xl bg-accent px-6 text-base font-bold text-bg active:opacity-80">
                Ver 3D
              </button>
            </div>
          ) : (
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-[#0d141d]">
              <PlantView />
              {selectedId && <AssetPanel id={selectedId} className="absolute inset-x-3 bottom-3" />}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
