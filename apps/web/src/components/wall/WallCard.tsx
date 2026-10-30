'use client';

import { ASSET_KINDS } from '@campo/shared';
import { fmtNum } from '@/lib/modules/kpis';
import { IconPause, IconPower, KIND_ICON } from '../icons';
import { RangeBar } from '../modules/RangeBar';
import { StatusChip, statusColor } from '../modules/StatusChip';
import { useCardData } from '../modules/useCardData';

/** Tarjeta del modo pared: nombre, estado y un valor enorme legible a 5 m. Las alarmas críticas llevan borde rojo grueso. */
export function WallCard({ id }: { id: string }) {
  const d = useCardData(id);
  const Icon = KIND_ICON[d.def?.type ?? 'other'];
  const machine = d.def?.type === 'machine';
  const running = (d.value ?? 0) >= 0.5;
  const critical = d.status === 'alarm' && d.severity !== 'warning';
  const tone = critical ? 'border-crit border-[0.28em] bg-crit/10' : d.status === 'alarm' || d.status === 'near' ? 'border-warn/70 border-[0.14em]' : 'border-line border-[0.08em]';
  const label = d.def ? ASSET_KINDS[d.def.type].label : 'Equipo';
  return (
    <article
      data-testid={`wall-card-${id}`}
      data-status={d.status}
      data-critical={critical ? 'true' : 'false'}
      aria-label={`${d.name}: ${label}`}
      className={`flex min-h-0 min-w-0 flex-col justify-between overflow-hidden rounded-[0.6em] bg-surface p-[0.7em] ${tone}`}
    >
      <header className="flex items-start justify-between gap-[0.5em]">
        <h3 className="flex min-w-0 items-center gap-[0.4em] text-[1.05em] leading-tight font-semibold">
          <Icon className="shrink-0 text-muted" />
          <span className="truncate">{d.name}</span>
        </h3>
        <span className="text-[0.75em]"><StatusChip status={d.status} severity={d.severity} size="lg" /></span>
      </header>
      {d.status === 'nodata' ? (
        <p className="text-[1.1em] text-muted">Sin datos</p>
      ) : machine ? (
        <p className={`flex items-center gap-[0.3em] text-[2.6em] leading-none font-extrabold ${running ? 'text-fg' : 'text-muted'}`}>
          {running ? <IconPower /> : <IconPause />}
          {running ? 'En marcha' : 'Detenida'}
        </p>
      ) : (
        <>
          <p className="flex items-baseline gap-[0.25em] leading-none">
            <span className="font-mono text-[3.4em] font-bold tracking-tight tabular-nums">{fmtNum(d.value, d.decimals)}</span>
            <span className="text-[1.2em] font-medium text-muted">{d.unit}</span>
          </p>
          {d.scale && <RangeBar value={d.value} scale={d.scale} limits={d.limits} color={statusColor(d.status, d.severity)} label={d.name} unit={d.unit} height={14} big />}
        </>
      )}
    </article>
  );
}
