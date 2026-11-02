'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { summarizeAlarms } from '@/lib/alarm-summary';
import { lifecycleOf, type LiveAlarm } from '@/lib/alarm-lifecycle';
import { fmtNum } from '@/lib/modules/kpis';
import { metricMeta } from '@/lib/metrics';
import { useLiveStore } from '@/store/live-store';
import { IconCheck, IconChevron, IconCritical, IconPause, IconWarning } from '../icons';
import { useAssetName, useAssetTag } from '../useAsset';
import { LatencyBadge } from './LatencyBadge';

function Entry({ a, first }: { a: LiveAlarm; first: boolean }) {
  const name = useAssetName(a.asset);
  const tag = useAssetTag(a.asset);
  const m = metricMeta(a.metric);
  const crit = a.severity === 'critical';
  const rtn = lifecycleOf(a) === 'rtn_unacked';
  const Icon = crit ? IconCritical : IconWarning;
  const what = a.rationale?.description || a.message || `${m.label} fuera de límite`;
  return (
    <li
      data-testid="footer-alarm"
      data-severity={a.severity}
      data-lifecycle={lifecycleOf(a)}
      className={`${first ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1 text-[13px] ${crit ? 'border-crit/70 text-crit' : 'border-warn/60 text-warn'} ${a.acknowledged ? 'opacity-75' : ''}`}
    >
      <Icon className="shrink-0 text-base" />
      <span className="flex min-w-0 flex-col leading-tight text-fg">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-semibold">{name}</span>
          <span className="shrink-0 font-mono text-[11px] text-muted" data-testid="footer-alarm-tag">{tag}</span>
          {a.kind && <span className="shrink-0 font-mono text-[11px] font-bold">{a.kind}</span>}
        </span>
        <span className="truncate text-[12px]">
          {rtn && <span className="font-semibold">Normalizada · </span>}
          <span className="text-muted">{what} · </span>
          <span className="font-mono tabular-nums">{fmtNum(a.value, m.decimals)} {m.unit}</span>
          <span className="text-muted">{' · límite '}{fmtNum(a.threshold, m.decimals)} {m.unit}</span>
        </span>
      </span>
    </li>
  );
}

function Count({ n, label, short, tone, testid, Icon }: { n: number; label: string; short: string; tone: 'crit' | 'warn' | 'none'; testid: string; Icon: typeof IconCritical }) {
  const cls = n === 0 || tone === 'none' ? 'border-line text-muted' : tone === 'crit' ? 'border-crit/70 bg-crit/15 text-crit' : 'border-warn/70 bg-warn/15 text-warn';
  return (
    <span data-testid={testid} data-count={n} aria-label={`${label}: ${n}`} className={`inline-flex min-h-8 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold ${cls}`}>
      <Icon className="text-sm" />
      <span className="hidden lg:inline">{label}</span>
      <span className="hidden sm:inline lg:hidden">{short}</span>
      <span className="font-mono tabular-nums">{n}</span>
    </span>
  );
}

/**
 * Pie global de la plantilla maestra: conteo por ciclo de vida (sin reconocer, normalizadas sin reconocer,
 * postergadas), las 3 más importantes con activo, descripción, valor y límite, y acceso a `/alarmas`.
 * Fijo en todas las pantallas salvo el modo pared.
 */
export function AlarmFooter() {
  const alarms = useLiveStore((s) => s.alarms);
  const s = useMemo(() => summarizeAlarms(alarms), [alarms]);
  const c = s.counts;
  return (
    <footer
      role="region"
      aria-label="Resumen de alarmas"
      data-testid="alarm-footer"
      data-total={s.total}
      data-critical={s.critical}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-surface px-3 py-1.5 md:flex-nowrap md:px-4"
    >
      <div className="flex shrink-0 items-center gap-1.5" aria-live="polite">
        <Count testid="footer-unacked" n={c.unacked.total} label="Sin reconocer" short="Sin rec." tone={c.unacked.critical > 0 ? 'crit' : 'warn'} Icon={IconCritical} />
        <Count testid="footer-rtn" n={c.rtn_unacked.total} label="Normalizadas sin reconocer" short="Normaliz." tone="warn" Icon={IconWarning} />
        <Count testid="footer-shelved" n={c.shelved.total} label="Postergadas" short="Postergadas" tone="none" Icon={IconPause} />
      </div>
      {s.total === 0 ? (
        <p data-testid="footer-empty" className="order-last flex min-w-0 basis-full items-center gap-1.5 truncate text-[13px] text-muted md:order-none md:basis-0 md:flex-1">
          <IconCheck className="shrink-0 text-base text-calm" /> Sin alarmas activas
        </p>
      ) : (
        <ul className="order-last flex min-w-0 basis-full gap-2 md:order-none md:basis-0 md:flex-1" aria-label="Alarmas más importantes">
          {s.top.map((a, i) => (
            <Entry key={a.id} a={a} first={i === 0} />
          ))}
        </ul>
      )}
      <LatencyBadge />
      <Link
        prefetch={false}
        href="/alarmas"
        data-testid="footer-all"
        className="ml-auto inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-sm font-semibold hover:bg-surface-2 md:ml-0"
      >
        Ver todas{s.total > 0 && <span className="font-mono tabular-nums">({s.total})</span>} <IconChevron className="text-base" />
      </Link>
    </footer>
  );
}
