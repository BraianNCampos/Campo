'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ASSET_KINDS, type Limit } from '@campo/shared';
import { config } from '@/lib/env';
import { bucketMs, DEFAULT_WINDOW, loadHistory, mergeHistoryLive, TREND_WINDOWS, windowById, windowRange, type HistoryPoint, type WindowId } from '@/lib/history';
import { fmtNum } from '@/lib/modules/kpis';
import { deviationModel, deviationText } from '@/lib/modules/deviation';
import { resolveScale } from '@/lib/modules/scale';
import { setpointOf } from '@/lib/modules/status';
import { metricMeta } from '@/lib/metrics';
import { readSeries } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { assetLabel } from '@/lib/assets';
import { GlassPanel } from '../GlassPanel';
import { useNow } from '../hooks';
import { IconClose, IconRefresh } from '../icons';
import { LineChart } from '../LineChart';
import { trendMetrics, trendRefLines } from './trend-model';
import { useTrendStore } from './trend-store';
import { useFocusTrap } from './useFocusTrap';

interface Load {
  status: 'loading' | 'ready' | 'error';
  points: HistoryPoint[] | null;
}
const NO_LIMITS: Limit[] = [];
const REFRESH_MS = 60_000;

/** Histórico de la API (si hay) para la métrica y ventana elegidas; se refresca cada minuto mientras el panel está abierto. */
function useHistory(plant: string, asset: string, metric: string, win: WindowId): Load & { retry(): void } {
  const key = `${plant}|${asset}|${metric}|${win}`;
  const [done, setDone] = useState<{ key: string; status: 'ready' | 'error'; points: HistoryPoint[] | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (config.mock) return;
    const ctl = new AbortController();
    const w = windowById(win);
    const { from, to } = windowRange(win, Date.now());
    loadHistory({ plant, asset, metric, from, to, bucket: w.bucket }, fetch, ctl.signal)
      .then((points) => setDone({ key, status: 'ready', points }))
      .catch((e: unknown) => {
        if ((e as { name?: string }).name !== 'AbortError') setDone((d) => ({ key, status: 'error', points: d?.key === key ? d.points : null }));
      });
    return () => ctl.abort();
  }, [plant, asset, metric, win, key, tick]);
  useEffect(() => {
    if (config.mock) return;
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  const retry = useCallback(() => setTick((t) => t + 1), []);
  if (config.mock) return { status: 'ready', points: null, retry };
  // un resultado de otra métrica o ventana no se mezcla: mientras llega el nuevo, «cargando»
  if (!done || done.key !== key) return { status: 'loading', points: null, retry };
  return { status: done.status, points: done.points, retry };
}

const seg = (on: boolean) =>
  `inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border px-3 text-sm font-semibold whitespace-nowrap ${
    on ? 'border-fg/70 bg-surface-2 text-fg' : 'border-line text-muted hover:bg-surface-2 hover:text-fg'
  }`;

function Panel({ asset, metric }: { asset: string; metric: string }) {
  const close = useTrendStore((s) => s.close);
  const setMetric = useTrendStore((s) => s.setMetric);
  const plant = useLiveStore((s) => s.plant);
  const def = useLiveStore((s) => s.catalog[asset]);
  const state = useLiveStore((s) => s.assets[asset]);
  const all = useLiveStore((s) => s.limitsByAsset[asset]) ?? NO_LIMITS;
  const alarmSeverity = useLiveStore((s) => s.alarmSeverityByAsset[asset]);
  const [win, setWin] = useState<WindowId>(DEFAULT_WINDOW);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, close);

  const primary = def ? ASSET_KINDS[def.type].primaryMetric : metric;
  const metrics = useMemo(() => trendMetrics(def, state, primary), [def, state, primary]);
  const limits = useMemo(() => all.filter((l) => l.metric === metric), [all, metric]);
  const sp = setpointOf(def, state?.values, metric);
  const lines = useMemo(() => trendRefLines(limits, sp), [limits, sp]);
  const meta = metricMeta(metric);
  const name = def?.name ?? assetLabel(asset);
  const value = state?.values[metric];
  const dev = deviationModel({ value, setpoint: sp, limits, scale: resolveScale(def, metric, limits), alarm: !!alarmSeverity });

  const h = useHistory(plant, asset, metric, win);
  const now = useNow(1000);
  const w = windowById(win);
  const series = useMemo(() => {
    const { from, to } = windowRange(win, now);
    return mergeHistoryLive(h.points ?? [], readSeries(asset, metric), from, to, bucketMs(w));
  }, [h.points, asset, metric, win, w, now]);
  const empty = h.status === 'ready' && series.t.length === 0;

  const onClose = useCallback(() => close(), [close]);

  return (
    <div className="fixed inset-0 z-50" data-testid="trend-root">
      <div className="absolute inset-0 bg-bg/60" onClick={onClose} aria-hidden="true" />
      <GlassPanel
        // lateral en escritorio, hoja inferior en móvil
        className="absolute inset-x-0 bottom-0 flex max-h-[90dvh] flex-col overflow-y-auto rounded-b-none md:inset-x-auto md:inset-y-3 md:right-3 md:max-h-none md:w-[460px] md:rounded-b-[14px]"
        role="dialog"
        aria-modal="true"
        aria-label={`Tendencia de ${meta.label.toLowerCase()} de ${name}`}
        data-testid="trend-panel"
        data-asset={asset}
        data-metric={metric}
        tabIndex={-1}
      >
        <div ref={ref} className="flex min-h-0 flex-1 flex-col gap-4 p-4 md:p-5">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[11px] tracking-wider text-muted uppercase">{asset}</p>
              <h2 className="truncate text-xl leading-tight font-bold">{name}</h2>
              <p className="mt-0.5 text-sm text-muted">{meta.label}{def ? ` · ${ASSET_KINDS[def.type].label}` : ''}</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Cerrar tendencia" data-testid="trend-close" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-line hover:bg-surface-2">
              <IconClose className="text-xl" />
            </button>
          </header>

          <div className="flex items-end justify-between gap-3">
            <p className="flex items-baseline gap-1.5 leading-none">
              <span data-testid="trend-value" className="font-mono text-[40px] font-bold tracking-tight tabular-nums">{fmtNum(value, meta.decimals)}</span>
              {meta.unit && <span className="text-base font-medium text-muted">{meta.unit}</span>}
            </p>
            {dev && <p data-testid="trend-deviation" className="text-right text-[13px] leading-tight text-muted">{deviationText(dev, meta.unit, meta.decimals)}</p>}
          </div>

          {metrics.length > 1 && (
            <div role="group" aria-label="Métrica" className="flex gap-2">
              {metrics.map((m) => (
                <button key={m} type="button" aria-pressed={m === metric} data-testid={`trend-metric-${m}`} onClick={() => setMetric(m)} className={seg(m === metric)}>
                  {metricMeta(m).label}
                </button>
              ))}
            </div>
          )}

          <div role="group" aria-label="Ventana de tiempo" className="flex gap-2">
            {TREND_WINDOWS.map((x) => (
              <button key={x.id} type="button" aria-pressed={x.id === win} data-testid={`trend-window-${x.id}`} onClick={() => setWin(x.id)} className={seg(x.id === win)}>
                {x.label}
              </button>
            ))}
          </div>

          <div className="relative" data-testid="trend-chart" data-state={h.status === 'loading' ? 'loading' : empty ? 'empty' : h.status === 'error' ? 'error' : 'ready'} aria-busy={h.status === 'loading'}>
            <LineChart asset={asset} metric={metric} windowSec={w.ms / 1000} height={230} series={series} refLines={lines} />
            {h.status === 'loading' && (
              <p role="status" className="pointer-events-none absolute inset-x-0 top-2 text-center text-sm text-muted">Cargando histórico…</p>
            )}
            {empty && (
              <p role="status" data-testid="trend-empty" className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted">
                Todavía no hay datos de esta métrica en los últimos {w.label}.
              </p>
            )}
          </div>
          {h.status === 'error' && (
            <div role="alert" data-testid="trend-error" className="flex items-center justify-between gap-3 rounded-lg border border-warn/60 bg-warn/10 px-3 py-2 text-sm">
              <span>No pudimos traer el histórico. Mostramos lo que llegó en vivo.</span>
              <button type="button" onClick={h.retry} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 font-semibold hover:bg-surface-2">
                <IconRefresh className="text-base" /> Reintentar
              </button>
            </div>
          )}

          {lines.length > 0 && (
            <ul data-testid="trend-lines" aria-label="Setpoint y límites de alarma" className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12px] tabular-nums">
              {lines.map((l) => (
                <li key={l.label} data-kind={l.kind} className={l.kind === 'critical' ? 'text-crit' : l.kind === 'warning' ? 'text-warn' : 'text-muted'}>
                  {l.label} {meta.unit}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">
            {config.mock ? 'Modo demo: la curva usa los últimos minutos recibidos en este navegador.' : 'Histórico del servidor completado con los datos en vivo.'}
          </p>
        </div>
      </GlassPanel>
    </div>
  );
}

/** Panel de tendencia a un clic: lateral en escritorio, hoja inferior en móvil. Se monta una vez en la plantilla maestra. */
export function TrendPanel() {
  const open = useTrendStore((s) => s.open);
  if (!open) return null;
  return <Panel key={open.asset} asset={open.asset} metric={open.metric} />;
}
