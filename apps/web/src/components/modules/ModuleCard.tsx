'use client';

import { memo, useMemo } from 'react';
import { ASSET_KINDS, type AssetDef } from '@campo/shared';
import { metricMeta } from '@/lib/metrics';
import { cardExtras } from '@/lib/modules/extras';
import { computeTrend, trendText, type Trend } from '@/lib/modules/trend';
import { fmtNum } from '@/lib/modules/kpis';
import { readSeries } from '@/store/history';
import { useNow, useHistoryVersion } from '../hooks';
import { IconPause, IconPower, KIND_ICON } from '../icons';
import { Sparkline } from '../Sparkline';
import { RangeBar } from './RangeBar';
import { StatusChip, statusColor } from './StatusChip';
import { useCardData } from './useCardData';

/** Tendencia de la métrica primaria (regresión sobre el buffer circular); se refresca ≤2 Hz sin tocar el resto de la tarjeta. */
function useTrend(id: string, metric: string, scale: { min: number; max: number } | undefined): Trend | null {
  const version = useHistoryVersion();
  const min = scale?.min;
  const max = scale?.max;
  return useMemo(() => {
    void version;
    return computeTrend(readSeries(id, metric), min !== undefined && max !== undefined ? { min, max } : undefined);
  }, [id, metric, min, max, version]);
}

function MachineValue({ running }: { running: boolean }) {
  const Icon = running ? IconPower : IconPause;
  return (
    <p className={`flex items-center gap-2 text-[28px] leading-none font-bold ${running ? 'text-fg' : 'text-muted'}`}>
      <Icon className="text-[26px]" />
      {running ? 'En marcha' : 'Detenida'}
    </p>
  );
}

function Footer({ id, def, values }: { id: string; def: AssetDef | undefined; values: Record<string, number> | undefined }) {
  const version = useHistoryVersion();
  const now = useNow(5000);
  const extras = useMemo(() => {
    void version;
    if (!def || !values) return [];
    return cardExtras({ def, values, series: (m) => readSeries(id, m), now });
  }, [def, values, id, version, now]);
  if (extras.length === 0) return null;
  return (
    <dl data-testid={`extras-${id}`} className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-2.5 text-[13px]">
      {extras.map((e) => (
        <div key={e.label} className="flex items-baseline gap-1.5">
          <dt className="text-muted">{e.label}</dt>
          {e.value && <dd className="font-mono font-semibold text-fg tabular-nums">{e.value}</dd>}
        </div>
      ))}
    </dl>
  );
}

function ModuleCardBase({ id }: { id: string }) {
  const d = useCardData(id);
  const trend = useTrend(id, d.metric, d.scale);
  const kind = d.def ? ASSET_KINDS[d.def.type] : undefined;
  const Icon = KIND_ICON[d.def?.type ?? 'other'];
  const isMachine = d.def?.type === 'machine';
  const color = statusColor(d.status, d.severity);
  const tone =
    d.status === 'alarm' ? (d.severity === 'warning' ? 'border-warn' : 'border-crit ring-1 ring-crit') : d.status === 'near' ? 'border-warn/60' : 'border-line';
  const noData = d.status === 'nodata';

  return (
    <article
      data-testid={`asset-card-${id}`}
      data-status={d.status}
      aria-label={`${d.name}: ${kind?.label ?? 'Equipo'}`}
      className={`flex flex-col rounded-xl border bg-surface p-4 ${tone}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[15px] leading-tight font-semibold">
            <Icon className="shrink-0 text-lg text-muted" />
            <span className="truncate">{d.name}</span>
          </h3>
          <p className="mt-0.5 truncate pl-7 font-mono text-[11px] text-muted">{id}</p>
        </div>
        <StatusChip status={d.status} severity={d.severity} data={`status-${id}`} />
      </header>

      {noData ? (
        <p data-testid={`nodata-${id}`} className="mt-4 text-sm text-muted">
          Todavía no llegaron datos de este activo.
        </p>
      ) : (
        <>
          <div className="mt-3 flex items-end justify-between gap-3">
            {isMachine ? (
              <MachineValue running={(d.value ?? 0) >= 0.5} />
            ) : (
              <p className="flex items-baseline gap-1.5 leading-none">
                <span data-testid={`value-${id}`} className="font-mono text-[38px] font-bold tracking-tight tabular-nums">
                  {fmtNum(d.value, d.decimals)}
                </span>
                {d.unit && <span className="text-base font-medium text-muted">{d.unit}</span>}
              </p>
            )}
            {!isMachine && (
              <p data-testid={`trend-${id}`} data-direction={trend?.direction ?? 'none'} className="pb-0.5 text-right text-[13px] leading-tight font-medium text-muted tabular-nums">
                {trendText(trend, d.unit ? d.unit : '', d.decimals)}
              </p>
            )}
          </div>
          {!isMachine && d.scale && (
            <div className="mt-3">
              <RangeBar value={d.value} scale={d.scale} limits={d.limits} color={color} label={`${metricMeta(d.metric).label} de ${d.name}`} unit={d.unit} setpoint={d.setpoint} />
            </div>
          )}
          {!isMachine && (
            <div className="mt-1">
              <Sparkline asset={id} metric={d.metric} height={34} color={color} />
            </div>
          )}
          <Footer id={id} def={d.def} values={d.state?.values} />
        </>
      )}
    </article>
  );
}

export const ModuleCard = memo(ModuleCardBase);
