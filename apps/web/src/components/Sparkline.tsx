'use client';

import { useMemo } from 'react';
import { metricMeta } from '@/lib/metrics';
import { readSeries } from '@/store/history';
import { useHistoryVersion } from './hooks';

/** Mini-curva SVG de las últimas N muestras. Se refresca ≤2 Hz. */
export function Sparkline({
  asset,
  metric,
  points = 60,
  height = 36,
  className = '',
  color = 'var(--color-accent)',
}: {
  asset: string;
  metric: string;
  points?: number;
  height?: number;
  className?: string;
  color?: string;
}) {
  const version = useHistoryVersion();
  const path = useMemo(() => {
    void version;
    const { v } = readSeries(asset, metric, points);
    if (v.length < 2) return null;
    const meta = metricMeta(metric);
    let lo = Math.min(...v);
    let hi = Math.max(...v);
    const minSpan = meta.min !== undefined && meta.max !== undefined ? (meta.max - meta.min) * 0.08 : 1;
    if (hi - lo < minSpan) {
      const mid = (hi + lo) / 2;
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const W = 100;
    const pts = v.map((x, i) => `${((i / (points - 1)) * W + (W - ((v.length - 1) / (points - 1)) * W)).toFixed(2)},${(
      height - 3 - ((x - lo) / (hi - lo)) * (height - 6)
    ).toFixed(2)}`);
    return { line: pts.join(' '), last: pts[pts.length - 1] ?? '' };
  }, [version, asset, metric, points, height]);

  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height, width: '100%' }}
      role="img"
      aria-label={`Tendencia de ${metricMeta(metric).label.toLowerCase()}`}
    >
      {path ? (
        <polyline
          points={path.line}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <line x1="0" x2="100" y1={height / 2} y2={height / 2} stroke="var(--color-line)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}
