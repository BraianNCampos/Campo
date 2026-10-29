import { clamp } from '@/lib/math';
import type { Threshold } from '@/lib/metrics';

/** Barra horizontal con marcas de umbral. role="meter" para lectores de pantalla. */
export function LevelBar({
  value,
  min = 0,
  max = 100,
  color,
  thresholds = [],
  label,
  height = 14,
}: {
  value: number | undefined;
  min?: number;
  max?: number;
  color: string;
  thresholds?: Threshold[];
  label: string;
  height?: number;
}) {
  const pct = value === undefined ? 0 : clamp(((value - min) / (max - min)) * 100, 0, 100);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value === undefined ? undefined : Math.round(value * 10) / 10}
      className="relative w-full overflow-hidden rounded-md border border-line bg-bg"
      style={{ height }}
    >
      <div className="h-full rounded-sm transition-[width] duration-300 ease-out" style={{ width: `${pct}%`, background: color }} />
      {thresholds.map((t) => (
        <span
          key={t.value}
          className="absolute top-0 h-full w-0.5 bg-fg/70"
          style={{ left: `${((t.value - min) / (max - min)) * 100}%` }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
