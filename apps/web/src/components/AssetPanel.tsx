'use client';

import { assetLabel, pumpRunning } from '@/lib/assets';
import { formatMetric, metricMeta } from '@/lib/metrics';
import { STATUS_META } from '@/lib/status';
import { useUiStore } from '@/store/ui-store';
import { IconPause, IconPower, KIND_ICON } from './icons';
import { LineChart } from './LineChart';
import { StatusBadge } from './StatusBadge';
import { useAsset } from './useAsset';

/** Panel flotante del equipo seleccionado: valores en vivo + mini-curva. */
export function AssetPanel({ id, className = '' }: { id: string; className?: string }) {
  const { state, kind, status } = useAsset(id);
  const select = useUiStore((s) => s.select);
  const Icon = KIND_ICON[kind];
  const entries = Object.entries(state?.values ?? {});
  const main = kind === 'tank' ? 'level' : kind === 'pump' ? 'rpm' : kind === 'valve' ? 'position' : (entries[0]?.[0] ?? 'value');
  const m = STATUS_META[status];

  return (
    <section
      aria-label={`Detalle de ${assetLabel(id)}`}
      data-testid="asset-panel"
      className={`w-72 rounded-2xl border bg-surface/95 p-4 shadow-xl backdrop-blur ${status === 'ok' ? 'border-line' : m.border} ${className}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Icon className="text-xl text-muted" />
            {assetLabel(id)}
          </h2>
          <p className="font-mono text-xs text-muted">{id}</p>
        </div>
        <button
          type="button"
          onClick={() => select(null)}
          aria-label="Cerrar detalle"
          className="-m-2 flex size-11 items-center justify-center rounded-lg text-xl text-muted hover:bg-surface-2 hover:text-fg"
        >
          ×
        </button>
      </header>
      <div className="mt-2 flex items-center gap-2">
        <StatusBadge status={status} size="sm" />
        {kind === 'pump' && (
          <span className={`inline-flex items-center gap-1 text-xs font-semibold ${pumpRunning(state?.values) ? 'text-ok' : 'text-muted'}`}>
            {pumpRunning(state?.values) ? <IconPower /> : <IconPause />}
            {pumpRunning(state?.values) ? 'En marcha' : 'Detenida'}
          </span>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{metricMeta(k).label}</dt>
            <dd data-testid={`panel-${k}`} className="font-mono text-xl font-bold tabular-nums">
              {formatMetric(k, v)}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 rounded-lg border border-line bg-bg">
        <LineChart asset={id} metric={main} windowSec={60} height={70} compact />
      </div>
      <p className="mt-1 text-xs text-muted">{metricMeta(main).label} · último minuto</p>
    </section>
  );
}
