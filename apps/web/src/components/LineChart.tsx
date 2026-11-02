'use client';

import { useEffect, useRef } from 'react';
import { metricMeta } from '@/lib/metrics';
import { readSeries, type Series } from '@/store/history';
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

/** Línea de referencia horizontal (setpoint o límite de alarma) con su rótulo. */
export interface RefLine {
  value: number;
  /** texto corto: «SP 60», «HH 90» */
  label: string;
  kind: 'sp' | 'warning' | 'critical';
}

/** Eje X legible: segundos, minutos u horas según la ventana. */
export function ageLabel(sec: number): string {
  if (sec <= 0) return 'ahora';
  if (sec < 120) return `-${sec} s`;
  if (sec < 7200) return `-${Math.round(sec / 60)} min`;
  return `-${Math.round((sec / 3600) * 2) / 2} h`.replace('.', ',');
}

/** Evita que los rótulos de las líneas se pisen: los empuja hacia abajo con al menos `gap` px entre sí. */
export function spreadLabels(ys: number[], gap: number, min: number, max: number): number[] {
  const order = ys.map((y, i) => i).sort((a, b) => ys[a]! - ys[b]!);
  const out = [...ys];
  let prev = min - gap;
  for (const i of order) {
    out[i] = Math.max(ys[i]!, prev + gap);
    prev = out[i]!;
  }
  const over = prev - max;
  if (over > 0) for (const i of order) out[i] = Math.max(min, out[i]! - over);
  return out;
}

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
  series,
  refLines,
}: {
  asset: string;
  metric: string;
  windowSec: number;
  height?: number;
  compact?: boolean;
  /** serie propia (histórico + vivo); sin ella se lee el búfer circular y el eje termina en la última muestra */
  series?: Series;
  /** SP y límites: sustituyen a los umbrales fijos de la métrica y entran en la escala vertical */
  refLines?: readonly RefLine[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const meta = metricMeta(metric);
  const name = useAssetName(asset);
  // el dibujo (≈5 Hz) lee siempre lo último sin reiniciar el efecto
  const seriesRef = useRef(series);
  const linesRef = useRef(refLines);
  useEffect(() => {
    seriesRef.current = series;
    linesRef.current = refLines;
  });

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

      const lines = linesRef.current;
      const m = compact ? { l: 4, r: 4, t: 6, b: 4 } : { l: 42, r: lines?.length ? 64 : 10, t: 10, b: 20 };
      const pw = w - m.l - m.r;
      const ph = h - m.t - m.b;
      const own = seriesRef.current;
      const { t, v } = own ?? readSeries(asset, metric);
      const tEnd = own ? Date.now() : t.length ? (t[t.length - 1] as number) : Date.now();
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
        for (const l of lines ?? []) {
          lo = Math.min(lo, l.value);
          hi = Math.max(hi, l.value);
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
        const steps = pw < 320 ? 2 : 4; // en anchos estrechos, menos etiquetas para que no se pisen
        for (let k = 0; k <= steps; k++) {
          const frac = k / steps;
          const x = m.l + frac * pw;
          ctx.strokeStyle = COLORS.grid;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, m.t);
          ctx.lineTo(Math.round(x) + 0.5, m.t + ph);
          ctx.stroke();
          const sec = Math.round(windowSec * (1 - frac));
          ctx.fillText(ageLabel(sec), Math.min(Math.max(x, m.l + 14), w - m.r - 14), h - 4);
        }
      }

      // SP y límites de alarma, con rótulo al borde derecho
      if (lines?.length) {
        const vis = lines.filter((l) => l.value >= lo && l.value <= hi);
        const ys = vis.map((l) => Y(l.value));
        const ly = spreadLabels(ys, 13, m.t + 6, m.t + ph - 6);
        ctx.font = '600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        vis.forEach((l, i) => {
          const y = Math.round(ys[i]!) + 0.5;
          const color = l.kind === 'critical' ? COLORS.crit : l.kind === 'warning' ? COLORS.warn : COLORS.text;
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.setLineDash(l.kind === 'sp' ? [2, 3] : [6, 4]);
          ctx.lineWidth = l.kind === 'sp' ? 1.25 : 1.5;
          ctx.beginPath();
          ctx.moveTo(m.l, y);
          ctx.lineTo(w - m.r, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(l.label, w - m.r + 5, ly[i]!);
        });
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      }
      // umbrales fijos de la métrica (sin líneas propias)
      for (const th of lines ? [] : (meta.thresholds ?? [])) {
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
      data-lines={refLines?.length ?? 0}
      className="block w-full"
      style={{ height }}
    />
  );
}
