import type { Limit } from '@campo/shared';
import type { Scale } from '@/lib/modules/scale';
import { scalePct } from '@/lib/modules/scale';

const fmt = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toString() : String(Math.round(v * 10) / 10));

/** Marcas de límite que se pueden rotular sin pisarse (separadas ≥ 11 % y lejos de los extremos). */
export function labelledLimits(limits: readonly Limit[], scale: Scale, edge = 6, gap = 11): Limit[] {
  const out: Limit[] = [];
  const sorted = [...limits].sort((a, b) => a.threshold - b.threshold);
  let lastPct = -100;
  for (const l of sorted) {
    const p = scalePct(l.threshold, scale);
    if (p < edge || p > 100 - edge || p - lastPct < gap) continue;
    out.push(l);
    lastPct = p;
  }
  return out;
}

/**
 * Barra con la escala de la métrica, el valor (relleno) y una marca en cada límite de alarma. Los límites
 * van en tono neutro: el color lo pone el estado (relleno), no la barra.
 */
export function RangeBar({
  value, scale, limits, color, label, unit = '', height = 10, big = false,
}: {
  value: number | undefined;
  scale: Scale;
  limits: readonly Limit[];
  color: string;
  label: string;
  unit?: string;
  height?: number;
  big?: boolean;
}) {
  const pct = value === undefined ? 0 : scalePct(value, scale);
  const labelled = big ? labelledLimits(limits, scale, 14, 18) : labelledLimits(limits, scale);
  return (
    <div className="w-full">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={scale.min}
        aria-valuemax={scale.max}
        aria-valuenow={value === undefined ? undefined : Math.round(value * 10) / 10}
        aria-valuetext={value === undefined ? 'sin datos' : `${fmt(value)} ${unit}`.trim()}
        className="relative w-full overflow-hidden rounded-[3px] bg-bg ring-1 ring-line ring-inset"
        style={{ height }}
      >
        <div className="h-full rounded-[2px]" style={{ width: `${pct}%`, background: color, transition: 'width 400ms ease-out' }} />
        {limits.map((l, i) => (
          <span
            key={`${l.operator}${l.threshold}${i}`}
            data-testid="limit-mark"
            data-severity={l.severity}
            className="absolute top-0 h-full w-[2px] -translate-x-1/2 bg-fg"
            style={{ left: `${scalePct(l.threshold, scale)}%`, opacity: l.severity === 'critical' ? 0.9 : 0.55 }}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className={`relative mt-1 font-mono text-muted tabular-nums ${big ? 'h-6 text-[length:inherit]' : 'h-4 text-[10.5px]'}`} aria-hidden="true">
        <span className="absolute left-0">{fmt(scale.min)}</span>
        {labelled.map((l, i) => (
          <span key={i} className="absolute -translate-x-1/2 text-fg/80" style={{ left: `${scalePct(l.threshold, scale)}%` }}>
            {fmt(l.threshold)}
          </span>
        ))}
        <span className="absolute right-0">{fmt(scale.max)}</span>
      </div>
    </div>
  );
}
