'use client';

import { useMemo } from 'react';
import { formatAgo } from '@/lib/math';
import { metricMeta } from '@/lib/metrics';
import { acknowledgeAlarm } from '@/live/alarm-actions';
import { sortAlarms, useLiveStore } from '@/store/live-store';
import { IconCheck, IconCritical, IconWarning } from './icons';
import { AssetName } from './AssetName';
import { useNow } from './hooks';

/** Lista de alarmas activas con botón de reconocimiento (≥44 px de alto). */
export function AlarmList({ onSelect }: { onSelect?: (assetId: string) => void }) {
  const alarmsMap = useLiveStore((s) => s.alarms);
  const notice = useLiveStore((s) => s.notice);
  const alarms = useMemo(() => sortAlarms(alarmsMap), [alarmsMap]);
  const now = useNow(1000);

  if (alarms.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-8 text-center">
        <IconCheck className="text-4xl text-ok" />
        <p className="font-semibold">Sin alarmas activas</p>
        <p className="text-sm text-muted">Todos los equipos dentro de sus límites.</p>
      </div>
    );
  }

  return (
    <div>
      {notice && (
        <p role="alert" className="mb-2 rounded-lg border border-crit/60 bg-crit/15 px-3 py-2 text-sm text-crit">
          {notice}
        </p>
      )}
      <ul className="flex flex-col gap-2" data-testid="alarm-list">
        {alarms.map((a) => {
          const crit = a.severity === 'critical';
          const Icon = crit ? IconCritical : IconWarning;
          const unit = metricMeta(a.metric).unit;
          return (
            <li
              key={a.id}
              data-testid="alarm-item"
              className={`rounded-xl border bg-surface p-3 ${crit ? 'border-crit/80' : 'border-warn/70'} ${a.acknowledged ? 'opacity-75' : ''}`}
            >
              <div className="flex items-start gap-3">
                <Icon className={`mt-0.5 shrink-0 text-2xl ${crit ? 'text-crit' : 'text-warn'}`} />
                <div className="min-w-0 flex-1">
                  <p className={`text-xs font-bold uppercase tracking-wide ${crit ? 'text-crit' : 'text-warn'}`}>
                    {crit ? 'Crítica' : 'Advertencia'} · {formatAgo(now - a.ts)}
                  </p>
                  <button
                    type="button"
                    onClick={() => onSelect?.(a.asset)}
                    className="mt-0.5 block min-h-6 text-left text-base font-semibold hover:underline"
                  >
                    <AssetName id={a.asset} />
                  </button>
                  <p className="text-sm text-muted">{a.message || `${metricMeta(a.metric).label} fuera de límite`}</p>
                  <p className="mt-1 font-mono text-sm tabular-nums">
                    {a.value.toFixed(1)} {unit} <span className="text-muted">/ umbral {a.threshold} {unit}</span>
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={a.acknowledged}
                onClick={() => void acknowledgeAlarm(a.id)}
                className={`mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border px-4 text-base font-semibold transition-colors ${
                  a.acknowledged
                    ? 'border-line text-muted'
                    : 'border-fg/40 bg-surface-2 text-fg hover:bg-line active:bg-line'
                }`}
              >
                <IconCheck className="text-lg" />
                {a.acknowledged ? 'Reconocida' : 'Reconocer'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
