'use client';

import { isStructure, isTankLike, pumpRunning } from '@/lib/assets';
import { formatMetric, metricMeta } from '@/lib/metrics';
import { STATUS_META } from '@/lib/status';
import { useUiStore } from '@/store/ui-store';
import Link from 'next/link';
import { IconChevron, IconInfo, IconPause, IconPower, KIND_ICON } from './icons';
import { unitModule } from '@/lib/modules/unit';
import { assetHref } from '@/lib/tags';
import { useActiveModuleIds } from './modules/derived';
import { LineChart } from './LineChart';
import { useModelStatus } from '@/scene/models/model-status';
import { StatusBadge, UncatalogedTag } from './StatusBadge';
import { useAsset } from './useAsset';

/** Panel flotante del equipo seleccionado: valores en vivo + mini-curva. */
export function AssetPanel({ id, className = '' }: { id: string; className?: string }) {
  const { state, def, kind, status, name, tag, uncataloged } = useAsset(id);
  const active = useActiveModuleIds();
  const mod = def ? unitModule(def) : null;
  const modelProblem = useModelStatus((s) => s.failed[id]);
  const select = useUiStore((s) => s.select);
  const Icon = KIND_ICON[kind];
  const entries = Object.entries(state?.values ?? {});
  const main = isTankLike(kind) ? 'level' : kind === 'pump' ? 'rpm' : kind === 'valve' ? 'position' : (entries[0]?.[0] ?? 'value');
  const m = STATUS_META[status];

  return (
    <section
      aria-label={`Detalle de ${name}`}
      data-testid="asset-panel"
      className={`rounded-2xl border bg-surface/95 p-4 shadow-xl backdrop-blur ${status === 'ok' ? 'border-line' : m.border} ${className}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Icon className="text-xl text-muted" />
            {name}
          </h2>
          <p className="font-mono text-xs text-muted" data-testid="panel-tag">{tag}</p>
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
        {!isStructure(kind) && <StatusBadge status={status} size="sm" />}
        {uncataloged && <UncatalogedTag />}
        {kind === 'pump' && (
          <span className={`inline-flex items-center gap-1 text-xs font-semibold ${pumpRunning(state?.values) ? 'text-calm' : 'text-muted'}`}>
            {pumpRunning(state?.values) ? <IconPower /> : <IconPause />}
            {pumpRunning(state?.values) ? 'En marcha' : 'Detenida'}
          </span>
        )}
      </div>
      {modelProblem && (
        <p data-testid="model-unavailable" title={modelProblem} className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <IconInfo className="shrink-0 text-sm" />
          Modelo no disponible: mostramos el modelo genérico.
        </p>
      )}
      {isStructure(kind) ? (
        <p className="mt-3 text-sm text-muted">Estructura decorativa: se dibuja en la Vista 3D y no envía datos.</p>
      ) : (
        status === 'nodata' && <p className="mt-3 text-sm text-muted">Todavía no llegaron datos de este activo.</p>
      )}
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
      {def && mod && active.includes(mod) && (
        <Link
          prefetch={false}
          href={assetHref(mod, def)}
          data-testid="panel-unit-link"
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 text-sm font-semibold hover:bg-line"
        >
          Ver detalle de la unidad <IconChevron className="text-base" />
        </Link>
      )}
      {status !== 'nodata' && !isStructure(kind) && (
        <>
          <div className="mt-3 rounded-lg border border-line bg-bg">
            <LineChart asset={id} metric={main} windowSec={60} height={70} compact />
          </div>
          <p className="mt-1 text-xs text-muted">{metricMeta(main).label} · último minuto</p>
        </>
      )}
    </section>
  );
}
