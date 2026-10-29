'use client';

import { useLiveStore } from '@/store/live-store';
import { IconBell } from './icons';

/** Contador de alarmas activas. Rojo si hay críticas, ámbar si sólo advertencias. */
export function AlarmBadge({ onClick }: { onClick?: () => void }) {
  const alarms = useLiveStore((s) => s.alarms);
  const list = Object.values(alarms);
  const count = list.length;
  const crit = list.some((a) => a.severity === 'critical');
  const unacked = list.filter((a) => !a.acknowledged).length;
  const tone = count === 0 ? 'text-muted border-line' : crit ? 'text-crit border-crit/80 bg-crit/15' : 'text-warn border-warn/70 bg-warn/15';
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      data-testid="alarm-count"
      aria-label={`${count} ${count === 1 ? 'alarma activa' : 'alarmas activas'}${unacked ? `, ${unacked} sin reconocer` : ''}`}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-full border px-3 text-base font-bold tabular-nums ${tone}`}
    >
      <IconBell className="text-xl" />
      <span aria-live="polite">{count}</span>
    </Tag>
  );
}
