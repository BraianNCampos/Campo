'use client';

import { metricMeta } from '@/lib/metrics';
import { useLiveStore } from '@/store/live-store';
import { useUiStore } from '@/store/ui-store';
import { AssetName } from './AssetName';
import { LineChart } from './LineChart';

const WINDOWS = [
  { s: 60, label: '1 min' },
  { s: 120, label: '2 min' },
  { s: 300, label: '5 min' },
];

/** Curvas en tiempo real (todas las métricas) del activo seleccionado. */
export function ChartsStrip() {
  const id = useUiStore((s) => s.selectedId);
  const windowSec = useUiStore((s) => s.windowSec);
  const setWindowSec = useUiStore((s) => s.setWindowSec);
  const metrics = useLiveStore((s) => (id ? Object.keys(s.assets[id]?.values ?? {}).join(',') : ''));

  return (
    <section aria-label="Curvas en tiempo real" className="flex h-full min-h-0 flex-col rounded-2xl border border-line bg-surface p-3">
      <header className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          Curvas en tiempo real{id && <span className="ml-2 font-normal text-muted"><AssetName id={id} /></span>}
        </h2>
        <div role="group" aria-label="Ventana de tiempo" className="flex overflow-hidden rounded-lg border border-line">
          {WINDOWS.map((w) => (
            <button
              key={w.s}
              type="button"
              aria-pressed={windowSec === w.s}
              onClick={() => setWindowSec(w.s)}
              className={`min-h-8 px-3 text-xs font-semibold ${windowSec === w.s ? 'bg-accent text-bg' : 'text-muted hover:bg-surface-2'}`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </header>
      {!id ? (
        <p className="m-auto text-sm text-muted">Selecciona un equipo para ver sus curvas.</p>
      ) : metrics === '' ? (
        <p className="m-auto text-sm text-muted">Aún no ha llegado telemetría de este activo.</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
          {metrics.split(',').filter(Boolean).map((m) => (
            <figure key={m} className="m-0 min-h-0">
              <figcaption className="mb-0.5 text-xs font-semibold text-muted">
                {metricMeta(m).label} <span className="font-normal">({metricMeta(m).unit})</span>
              </figcaption>
              <LineChart asset={id} metric={m} windowSec={windowSec} height={132} />
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
