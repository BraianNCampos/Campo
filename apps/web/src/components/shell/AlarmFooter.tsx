'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { AlarmEvent } from '@campo/shared';
import { summarizeAlarms } from '@/lib/alarm-summary';
import { fmtNum } from '@/lib/modules/kpis';
import { metricMeta } from '@/lib/metrics';
import { useLiveStore } from '@/store/live-store';
import { IconCheck, IconChevron, IconCritical, IconWarning } from '../icons';
import { useAssetName } from '../useAsset';

function Entry({ a, first }: { a: AlarmEvent; first: boolean }) {
  const name = useAssetName(a.asset);
  const m = metricMeta(a.metric);
  const crit = a.severity === 'critical';
  const Icon = crit ? IconCritical : IconWarning;
  return (
    <li
      data-testid="footer-alarm"
      data-severity={a.severity}
      className={`${first ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1 text-[13px] ${crit ? 'border-crit/70 text-crit' : 'border-warn/60 text-warn'} ${a.acknowledged ? 'opacity-70' : ''}`}
    >
      <Icon className="shrink-0 text-base" />
      <span className="flex min-w-0 flex-col leading-tight text-fg md:block md:truncate">
        <span className="truncate font-semibold max-md:text-[13px]">{name}</span>
        <span className="truncate text-[12px] md:text-[13px]">
          <span className="font-mono tabular-nums">
            <span className="hidden md:inline">{' · '}</span>{fmtNum(a.value, m.decimals)} {m.unit}
          </span>
          <span className="text-muted">
            {' · límite '}{fmtNum(a.threshold, m.decimals)} {m.unit}
          </span>
        </span>
      </span>
    </li>
  );
}

/**
 * Pie global de la plantilla maestra: conteo de alarmas activas por prioridad, las 3 más importantes (activo, valor y
 * límite) y acceso a la lista completa. Fijo en todas las pantallas salvo el modo pared.
 */
export function AlarmFooter() {
  const alarms = useLiveStore((s) => s.alarms);
  const s = useMemo(() => summarizeAlarms(alarms), [alarms]);
  const chip = (n: number, tone: 'crit' | 'warn') => (n > 0 ? (tone === 'crit' ? 'border-crit/70 bg-crit/15 text-crit' : 'border-warn/70 bg-warn/15 text-warn') : 'border-line text-muted');
  return (
    <footer
      role="region"
      aria-label="Resumen de alarmas activas"
      data-testid="alarm-footer"
      data-total={s.total}
      className="flex shrink-0 items-center gap-3 border-t border-line bg-surface px-3 py-1.5 md:px-4"
    >
      <div className="flex shrink-0 items-center gap-1.5" aria-live="polite">
        <span data-testid="footer-critical" className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold ${chip(s.critical, 'crit')}`}>
          <IconCritical className="text-sm" /> <span className="hidden sm:inline">Críticas</span> <span className="font-mono tabular-nums">{s.critical}</span>
        </span>
        <span data-testid="footer-warning" className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold ${chip(s.warning, 'warn')}`}>
          <IconWarning className="text-sm" /> <span className="hidden sm:inline">Advertencias</span> <span className="font-mono tabular-nums">{s.warning}</span>
        </span>
      </div>
      {s.total === 0 ? (
        <p data-testid="footer-empty" className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13px] text-muted">
          <IconCheck className="shrink-0 text-base text-calm" /> Sin alarmas activas
        </p>
      ) : (
        <ul className="flex min-w-0 flex-1 gap-2" aria-label="Alarmas más importantes">
          {s.top.map((a, i) => (
            <Entry key={a.id} a={a} first={i === 0} />
          ))}
        </ul>
      )}
      <Link
        prefetch={false}
        href="/alarmas"
        data-testid="footer-all"
        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-sm font-semibold hover:bg-surface-2"
      >
        Ver todas{s.total > 0 && <span className="font-mono tabular-nums">({s.total})</span>} <IconChevron className="text-base" />
      </Link>
    </footer>
  );
}
