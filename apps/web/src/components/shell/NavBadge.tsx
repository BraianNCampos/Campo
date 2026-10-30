import type { ModuleBadge } from '@/lib/modules/summary';

/** Insignia de atención: ámbar si hay activos cerca del límite, roja si hay alarma crítica. No aparece si todo está bien. */
export function NavBadge({ badge, testId }: { badge: ModuleBadge | undefined; testId?: string }) {
  if (!badge || badge.attention === 0) return null;
  const cls = badge.critical ? 'bg-crit text-bg' : 'bg-warn text-bg';
  return (
    <span
      data-testid={testId}
      data-tone={badge.critical ? 'crit' : 'warn'}
      aria-label={`${badge.attention} ${badge.attention === 1 ? 'activo requiere' : 'activos requieren'} atención`}
      className={`min-w-5 rounded-full px-1.5 text-center font-mono text-[11px] leading-5 font-bold tabular-nums ${cls}`}
    >
      {badge.attention}
    </span>
  );
}
