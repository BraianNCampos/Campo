'use client';

import { useEffect } from 'react';
import { latencyLevel, type LatencyLevel } from '@/live/latency';
import { useLatencyStore } from '@/store/latency-store';
import { useLiveStore } from '@/store/live-store';

const TONE: Record<LatencyLevel, string> = {
  ok: 'border-line text-calm',
  warn: 'border-warn/70 bg-warn/15 text-warn',
  crit: 'border-crit/70 bg-crit/15 text-crit',
};
const LEVEL_LABEL: Record<LatencyLevel, string> = { ok: 'normal', warn: 'elevada', crit: 'crítica' };

const ms = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(0)} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

/**
 * Insignia de latencia extremo a extremo (§13): p50 / p95 de los últimos 60 s, medidos al pintar. Verde < 500 ms,
 * ámbar 500–2000, rojo > 2000 (color + texto «elevada/crítica»). En demo (sin `ingestTs`) muestra «Demo» y la latencia
 * del búfer simulado si la hay. Si la escena 3D no está montada, mide ella misma en su propio rAF (respaldo).
 */
export function LatencyBadge() {
  const p50 = useLatencyStore((s) => s.p50);
  const p95 = useLatencyStore((s) => s.p95);
  const count = useLatencyStore((s) => s.count);
  const mode = useLiveStore((s) => s.mode);
  const connection = useLiveStore((s) => s.connection);
  const buffer = useLiveStore((s) => s.latencyMs);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 250) return;
      last = t;
      useLatencyStore.getState().paint('fallback');
    };
    raf = requestAnimationFrame(loop);
    // las cifras caducan aunque no lleguen datos nuevos
    const tick = setInterval(() => useLatencyStore.getState().refresh(), 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(tick);
    };
  }, []);

  let text: string;
  let tone: string;
  let level: LatencyLevel | null = null;
  let title: string;
  if (count > 0 && p50 !== null && p95 !== null) {
    level = latencyLevel(Math.max(p50, p95));
    text = `p50 ${ms(p50)} · p95 ${ms(p95)}`;
    tone = TONE[level];
    title = `Latencia extremo a extremo (últimos 60 s, ${count} muestras): ${LEVEL_LABEL[level]}`;
  } else if (mode === 'mock') {
    text = buffer !== null ? `Demo · ${ms(buffer)}` : 'Demo';
    tone = 'border-line text-muted';
    title = 'Datos simulados: sin sello de ingesta; se muestra la latencia del búfer simulado';
  } else {
    text = connection === 'open' ? 'Latencia —' : 'Sin enlace';
    tone = 'border-line text-muted';
    title = connection === 'open' ? 'Midiendo la latencia…' : 'Sin conexión en vivo';
  }

  return (
    <span
      data-testid="latency-badge"
      data-level={level ?? 'none'}
      title={title}
      aria-label={level ? `Latencia ${LEVEL_LABEL[level]}: ${text}` : `Latencia: ${text}`}
      className={`inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums ${tone}`}
    >
      {level && level !== 'ok' && <span className="font-sans uppercase tracking-wide">{LEVEL_LABEL[level]}</span>}
      <span>{text}</span>
    </span>
  );
}
