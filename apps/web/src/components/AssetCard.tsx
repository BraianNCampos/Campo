'use client';

import { pumpRunning } from '@/lib/assets';
import { formatMetric, metricMeta } from '@/lib/metrics';
import { STATUS_META } from '@/lib/status';
import { formatNumber } from '@/lib/math';
import { IconPause, IconPower, KIND_ICON } from './icons';
import { LevelBar } from './LevelBar';
import { Sparkline } from './Sparkline';
import { StatusBadge, UncatalogedTag } from './StatusBadge';
import { useAsset } from './useAsset';

function BigValue({ id, metric, value }: { id: string; metric: string; value: number | undefined }) {
  const meta = metricMeta(metric);
  return (
    <p className="flex items-baseline gap-1.5 leading-none">
      <span data-testid={`value-${id}`} className="font-mono text-[40px] font-bold tabular-nums tracking-tight">
        {formatNumber(value, meta.decimals)}
      </span>
      <span className="text-lg font-medium text-muted">{meta.unit}</span>
    </p>
  );
}

/** Tarjeta de activo para móvil: valor principal grande, barra, estado y sparkline. */
export function AssetCard({ id }: { id: string }) {
  const { state, kind, status, name, uncataloged } = useAsset(id);
  const Icon = KIND_ICON[kind];
  const meta = STATUS_META[status];
  const v = state?.values ?? {};
  const main = kind === 'tank' ? 'level' : kind === 'pump' ? 'rpm' : kind === 'valve' ? 'position' : (Object.keys(v)[0] ?? 'value');
  const color = status === 'ok' ? 'var(--color-accent)' : `var(--color-${status === 'critical' ? 'crit' : status === 'bad' ? 'bad' : 'warn'})`;
  const running = pumpRunning(v);

  return (
    <article
      data-testid={`asset-card-${id}`}
      aria-label={`${name}: ${meta.label}`}
      className={`rounded-2xl border bg-surface p-3.5 ${status === 'ok' ? 'border-line' : meta.border} ${
        status === 'critical' ? 'shadow-[0_0_0_1px_var(--color-crit)]' : ''
      }`}
    >
      <header className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Icon className="text-xl text-muted" />
          {name}
          <span className="font-mono text-xs font-normal text-muted">{id}</span>
        </h3>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {uncataloged && <UncatalogedTag />}
          <StatusBadge status={status} size="sm" />
        </span>
      </header>

      {status === 'nodata' ? (
        <p data-testid={`nodata-${id}`} className="mt-3 text-sm text-muted">
          Aún no ha llegado telemetría de este activo.
        </p>
      ) : (
        <>
          <div className="mt-2.5 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="mb-1 text-sm text-muted">{metricMeta(main).label}</p>
              <BigValue id={id} metric={main} value={v[main]} />
            </div>
            <div className="w-36 shrink-0 pb-1">
              <Sparkline asset={id} metric={main} height={44} color={color} />
            </div>
          </div>

          {kind === 'tank' && (
            <div className="mt-2.5">
              <LevelBar value={v.level} color={color} thresholds={metricMeta('level').thresholds} label={`Nivel de ${name}`} height={16} />
              <p className="mt-1.5 text-sm text-muted">
                Temperatura <span className="font-mono font-semibold text-fg tabular-nums">{formatMetric('temp', v.temp)}</span>
              </p>
            </div>
          )}
          {kind === 'pump' && (
            <p className="mt-3 flex items-center justify-between text-sm text-muted">
              <span className={`inline-flex items-center gap-1.5 font-semibold ${running ? 'text-ok' : 'text-muted'}`}>
                {running ? <IconPower className="text-base" /> : <IconPause className="text-base" />}
                {running ? 'En marcha' : 'Detenida'}
              </span>
              <span>
                Corriente <span className="font-mono font-semibold text-fg tabular-nums">{formatMetric('current', v.current)}</span>
              </span>
            </p>
          )}
          {kind === 'valve' && (
            <div className="mt-3">
              <LevelBar value={v.position} color={color} label={`Apertura de ${name}`} height={16} />
              <p className="mt-2 text-sm font-semibold text-muted">
                {(v.position ?? 0) < 2 ? 'Cerrada' : (v.position ?? 0) > 98 ? 'Abierta' : 'Parcialmente abierta'}
              </p>
            </div>
          )}
        </>
      )}
    </article>
  );
}
