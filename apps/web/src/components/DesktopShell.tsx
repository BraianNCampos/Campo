'use client';

import { useEffect } from 'react';
import { resolveKind } from '@/lib/assets';
import { useLiveStore } from '@/store/live-store';
import { useUiStore } from '@/store/ui-store';
import { AlarmList } from './AlarmList';
import { AssetList } from './AssetList';
import { AssetPanel } from './AssetPanel';
import { ChartsStrip } from './ChartsStrip';
import { PlantView } from './PlantView';

/** Módulo «Vista 3D», escritorio: lista de activos | gemelo 3D + curvas | alarmas. */
export function DesktopShell() {
  const selectedId = useUiStore((s) => s.selectedId);
  const select = useUiStore((s) => s.select);
  const firstTank = useLiveStore((s) => s.assetIds.find((id) => resolveKind(id, undefined, s.catalog[id]?.type) === 'tank') ?? s.assetIds[0]);

  // selección inicial para que las curvas no arranquen vacías
  useEffect(() => {
    if (!useUiStore.getState().selectedId && firstTank) select(firstTank);
  }, [firstTank, select]);

  return (
    <div className="desk-grid h-full min-h-[560px] gap-3 p-3">
      <div style={{ gridArea: 'assets' }} className="flex min-h-0 flex-col gap-3">
        <div className="min-h-0 flex-1">
          <AssetList />
        </div>
        {selectedId && <AssetPanel id={selectedId} className="shrink-0" />}
      </div>

      <section aria-label="Gemelo digital 3D" style={{ gridArea: 'scene' }} className="relative min-h-0 overflow-hidden rounded-xl border border-line bg-[#0d141d]">
        <PlantView />
        <p className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-bg/70 px-2 py-1 text-xs text-muted">
          Arrastrá para orbitar · rueda para acercar · clic en un equipo para ver el detalle
        </p>
      </section>

      <div style={{ gridArea: 'charts' }} className="min-h-0">
        <ChartsStrip />
      </div>

      <aside aria-label="Alarmas" style={{ gridArea: 'alarms' }} className="flex min-h-0 flex-col rounded-xl border border-line bg-bg/50">
        <h2 className="px-4 pt-3 pb-2 text-sm font-semibold">Alarmas activas</h2>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <AlarmList onSelect={select} />
        </div>
      </aside>
    </div>
  );
}
