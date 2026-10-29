'use client';

import { useState } from 'react';
import { useLiveStore } from '@/store/live-store';
import { useUiStore, type MobileTab } from '@/store/ui-store';
import { AlarmList } from './AlarmList';
import { AssetCard } from './AssetCard';
import { AssetPanel } from './AssetPanel';
import { Header } from './Header';
import { IconBell, IconCube, IconGrid } from './icons';
import { OfflineBanner } from './OfflineBanner';
import { PlantView } from './PlantView';

const TABS: { id: MobileTab; label: string; Icon: typeof IconGrid }[] = [
  { id: 'summary', label: 'Resumen', Icon: IconGrid },
  { id: 'alarms', label: 'Alarmas', Icon: IconBell },
  { id: '3d', label: '3D', Icon: IconCube },
];

/** Móvil (<768px): tarjetas, alarmas y 3D opt-in. El Canvas NO se monta por defecto. */
export function MobileShell() {
  const tab = useUiStore((s) => s.mobileTab);
  const setTab = useUiStore((s) => s.setTab);
  const selectedId = useUiStore((s) => s.selectedId);
  const select = useUiStore((s) => s.select);
  const ids = useLiveStore((s) => s.assetIds);
  const alarmCount = useLiveStore((s) => Object.keys(s.alarms).length);
  const [want3d, setWant3d] = useState(false);

  return (
    <div className="flex h-dvh flex-col">
      <Header onAlarmsClick={() => setTab('alarms')} />
      <OfflineBanner />

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain" id="main">
        {tab === 'summary' && (
          <section aria-label="Resumen de activos" className="grid grid-cols-1 gap-3 p-3 min-[600px]:grid-cols-2">
            {ids.length === 0 && <p className="p-4 text-muted">Esperando datos…</p>}
            {ids.map((id) => (
              <AssetCard key={id} id={id} />
            ))}
          </section>
        )}

        {tab === 'alarms' && (
          <section aria-label="Alarmas activas" className="p-3">
            <h2 className="mb-3 text-lg font-bold">Alarmas activas</h2>
            <AlarmList
              onSelect={(id) => {
                select(id);
                setTab('summary');
              }}
            />
          </section>
        )}

        {tab === '3d' && (
          <section aria-label="Gemelo digital 3D" className="flex h-full min-h-80 flex-col p-3">
            {!want3d ? (
              <div className="m-auto flex max-w-xs flex-col items-center gap-4 text-center">
                <IconCube className="text-6xl text-accent" />
                <p className="text-lg font-semibold">Gemelo digital 3D</p>
                <p className="text-sm text-muted">
                  La vista 3D consume más batería y datos, por eso no se carga automáticamente.
                </p>
                <button
                  type="button"
                  onClick={() => setWant3d(true)}
                  className="min-h-12 w-full rounded-xl bg-accent px-6 text-base font-bold text-bg active:opacity-80"
                >
                  Ver 3D
                </button>
              </div>
            ) : (
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-[#0d141d]">
                <PlantView />
                {selectedId && <AssetPanel id={selectedId} className="absolute inset-x-3 bottom-3" />}
              </div>
            )}
          </section>
        )}
      </main>

      <nav
        aria-label="Navegación principal"
        className="grid grid-cols-3 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        {TABS.map(({ id, label, Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => setTab(id)}
              data-testid={`tab-${id}`}
              className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-semibold ${
                active ? 'text-accent' : 'text-muted'
              }`}
            >
              {active && <span className="absolute top-0 h-0.5 w-10 rounded-full bg-accent" aria-hidden="true" />}
              <Icon className="text-2xl" />
              {label}
              {id === 'alarms' && alarmCount > 0 && (
                <span className="absolute top-1.5 right-[calc(50%-24px)] min-w-5 rounded-full bg-crit px-1 text-center text-[11px] leading-5 font-bold text-bg">
                  {alarmCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
