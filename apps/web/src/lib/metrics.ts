import { METRICS as SHARED_METRICS } from '@campo/shared';
import { formatNumber } from './math';

export interface Threshold {
  value: number;
  severity: 'warning' | 'critical';
}

export interface MetricMeta {
  label: string;
  unit: string;
  decimals: number;
  /** Rango fijo del eje; sin él, autoescala */
  min?: number;
  max?: number;
  thresholds?: Threshold[];
}

export const METRICS: Record<string, MetricMeta> = {
  level: {
    label: 'Nivel',
    unit: '%',
    decimals: 1,
    min: 0,
    max: 100,
    thresholds: [
      { value: 10, severity: 'critical' },
      { value: 90, severity: 'critical' },
    ],
  },
  temp: { label: 'Temperatura', unit: '°C', decimals: 1, thresholds: [{ value: 30, severity: 'warning' }] },
  rpm: { label: 'Velocidad', unit: 'rpm', decimals: 0, min: 0, max: 1800 },
  current: { label: 'Corriente', unit: 'A', decimals: 1, min: 0, max: 16 },
  position: { label: 'Apertura', unit: '%', decimals: 0, min: 0, max: 100 },
};

export function metricMeta(metric: string): MetricMeta {
  const own = METRICS[metric];
  if (own) return own;
  const shared = SHARED_METRICS[metric];
  return shared ? { label: shared.label, unit: shared.unit, decimals: shared.decimals } : { label: metric, unit: '', decimals: 2 };
}

export function formatMetric(metric: string, v: number | undefined, withUnit = true): string {
  const m = metricMeta(metric);
  const s = formatNumber(v, m.decimals);
  return withUnit && m.unit && s !== '—' ? `${s} ${m.unit}` : s;
}
