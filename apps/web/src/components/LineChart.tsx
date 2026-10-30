'use client';

import { useEffect, useRef } from 'react';
import { metricMeta } from '@/lib/metrics';
import { readSeries } from '@/store/history';
import { useAssetName } from './useAsset';

/** Colores de la curva: salen de los tokens del tema (oscuro o alto contraste) en cada dibujo. */
function chartColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const light = document.documentElement.getAttribute('data-theme') === 'contrast';
  const line = v('--color-calm-bar', '#4a9d8d');
  return {
    line,
    fill: light ? 'rgba(29,122,105,0.16)' : 'rgba(79,209,165,0.13)',
    grid: light ? 'rgba(6,18,27,0.22)' : 'rgba(163,179,198,0.16)',
    text: v('--color-muted', '#a3b3c6'),
    crit: v('--color-crit', '#ff6b6b'),
    warn: v('--color-warn', '#fbbf24'),
  };
}
const REDRAW_MS = 200;

export function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** Curva en tiempo real dibujada en <canvas>, sin re-render de React (≈5 Hz). */
export function LineChart({
  asset,
  metric,
  windowSec,
  height = 150,
  compact = false,
}: {
  asset: string;
  metric: string;
  windowSec: number;
  height?: number;
  compact?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const meta = metricMeta(metric);
  const name = useAssetName(asset);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const COLORS = chartColors();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const m = compact ? { l: 4, r: 4, t: 6, b: 4 } : { l: 42, r: 10, t: 10, b: 20 };
      const pw = w - m.l - m.r;
      const ph = h - m.t - m.b;
      const { t, v } = readSeries(asset, metric);
      const tEnd = t.length ? (t[t.length - 1] as number) : Date.now();
      const tStart = tEnd - windowSec * 1000;

      let lo = meta.min ?? Infinity;
      let hi = meta.max ?? -Infinity;
      if (meta.min === undefined || meta.max === undefined) {
        for (let i = 0; i < t.length; i++) {
          if ((t[i] as number) >= tStart) {
            lo = Math.min(lo, v[i] as number);
            hi = Math.max(hi, v[i] as number);
          }
        }
        if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
        const pad = Math.max((hi - lo) * 0.15, 0.5);
        lo -= pad;
        hi += pad;
      }
      const X = (ti: number) => m.l + ((ti - tStart) / (tEnd - tStart)) * pw;
      const Y = (vi: number) => m.t + ph - ((vi - lo) / (hi - lo)) * ph;

      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;

      // rejilla y etiquetas Y
      ctx.strokeStyle = COLORS.grid;
      ctx.fillStyle = COLORS.text;
      for (const tick of niceTicks(lo, hi, compact ? 2 : 4)) {
        const y = Math.round(Y(tick)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(m.l, y);
        ctx.lineTo(w - m.r, y);
        ctx.stroke();
        if (!compact) {
          ctx.textAlign = 'right';
          ctx.fillText(String(tick), m.l - 6, y);
        }
      }
      // etiquetas X
      if (!compact) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        for (let k = 0; k <= 4; k++) {
          const frac = k / 4;
          const x = m.l + frac * pw;
          ctx.strokeStyle = COLORS.grid;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, m.t);
          ctx.lineTo(Math.round(x) + 0.5, m.t + ph);
          ctx.stroke();
          const sec = Math.round(windowSec * (1 - frac));
          ctx.fillText(sec === 0 ? 'ahora' : `-${sec >= 120 ? Math.round(sec / 60) + ' min' : sec + ' s'}`, Math.min(Math.max(x, m.l + 14), w - m.r - 14), h - 4);
        }
      }

      // umbrales
      for (const th of meta.thresholds ?? []) {
        if (th.value < lo || th.value > hi) continue;
        const y = Math.round(Y(th.value)) + 0.5;
        ctx.strokeStyle = th.severity === 'critical' ? COLORS.crit : COLORS.warn;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(m.l, y);
        ctx.lineTo(w - m.r, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // serie
      ctx.save();
      ctx.beginPath();
      ctx.rect(m.l, m.t - 2, pw, ph + 4);
      ctx.clip();
      let first = -1;
      ctx.beginPath();
      for (let i = 0; i < t.length; i++) {
        if ((t[i] as number) < tStart - 2000) continue;
        const x = X(t[i] as number);
        const y = Y(v[i] as number);
        if (first < 0) {
          first = i;
          ctx.moveTo(x, y);
        } else ctx.lineTo(x, y);
      }
      if (first >= 0) {
        ctx.strokeStyle = COLORS.line;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.lineTo(X(t[t.length - 1] as number), m.t + ph);
        ctx.lineTo(X(t[first] as number), m.t + ph);
        ctx.closePath();
        ctx.fillStyle = COLORS.fill;
        ctx.fill();
      }
      ctx.restore();

      if (t.length) {
        const x = X(t[t.length - 1] as number);
        const y = Y(v[v.length - 1] as number);
        ctx.fillStyle = COLORS.line;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    draw();
    const id = setInterval(draw, REDRAW_MS);
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => {
      clearInterval(id);
      ro.disconnect();
    };
  }, [asset, metric, windowSec, compact, meta]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={`Curva de ${meta.label.toLowerCase()} de ${name}`}
      data-testid={`chart-${asset}-${metric}`}
      className="block w-full"
      style={{ height }}
    />
  );
}
