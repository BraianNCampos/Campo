import type { Series } from '@/store/history';
import type { Scale } from './scale';

export type TrendDirection = 'steady' | 'up' | 'down';

export interface Trend {
  direction: TrendDirection;
  /** cambio por hora, en la unidad de la métrica (con signo) */
  perHour: number;
}

/** Ventana de la regresión: los últimos 5 min del buffer circular. */
export const TREND_WINDOW_MS = 5 * 60_000;
/** Mínimo de muestras y de tiempo cubierto para afirmar una tendencia. */
export const TREND_MIN_POINTS = 5;
export const TREND_MIN_SPAN_MS = 20_000;
/**
 * «Estable»: la tasa es menor que el 3 % de la escala por hora (nivel: 3 %/h; temperatura en −10…50 °C: 1,8 °C/h;
 * potencia en 0…200 kW: 6 kW/h). Por debajo de eso es ruido o deriva lenta que no cambia ninguna decisión.
 */
export const STEADY_FRACTION_PER_HOUR = 0.03;

/** Pendiente de la recta de mínimos cuadrados, en unidades de valor por hora. `null` si no hay datos suficientes. */
export function slopePerHour(series: Series, now?: number): number | null {
  const end = now ?? series.t[series.t.length - 1];
  if (end === undefined) return null;
  const t: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < series.t.length; i++) {
    const ti = series.t[i]!;
    if (ti >= end - TREND_WINDOW_MS && Number.isFinite(series.v[i])) {
      t.push(ti);
      v.push(series.v[i]!);
    }
  }
  if (t.length < TREND_MIN_POINTS || t[t.length - 1]! - t[0]! < TREND_MIN_SPAN_MS) return null;
  const n = t.length;
  const t0 = t[0]!;
  let st = 0, sv = 0;
  for (let i = 0; i < n; i++) {
    st += t[i]! - t0;
    sv += v[i]!;
  }
  const mt = st / n, mv = sv / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dt = t[i]! - t0 - mt;
    num += dt * (v[i]! - mv);
    den += dt * dt;
  }
  if (den === 0) return null;
  return (num / den) * 3_600_000; // por ms → por hora
}

/** Tendencia (estable/subiendo/bajando) de una serie. `null` mientras no haya datos suficientes. */
export function computeTrend(series: Series, scale: Scale | undefined, now?: number): Trend | null {
  const perHour = slopePerHour(series, now);
  if (perHour === null) return null;
  const span = scale ? scale.max - scale.min : 0;
  const limit = span > 0 ? span * STEADY_FRACTION_PER_HOUR : 1e-6; // sin escala, sólo el ruido numérico es «estable»
  const direction: TrendDirection = Math.abs(perHour) < limit ? 'steady' : perHour > 0 ? 'up' : 'down';
  return { direction, perHour };
}

export const TREND_LABEL: Record<TrendDirection, string> = { steady: 'estable', up: 'subiendo', down: 'bajando' };
export const TREND_ARROW: Record<TrendDirection, string> = { steady: '→', up: '↗', down: '↘' };

/** «+10 kW/h», «−3.2 %/h»; las unidades que ya son por hora se escriben «m³/h por hora». */
export function formatRate(perHour: number, unit: string, decimals = 1): string {
  const abs = Math.abs(perHour);
  const d = abs >= 100 ? 0 : abs >= 10 ? Math.min(decimals, 1) : decimals;
  const num = `${perHour < 0 ? '−' : '+'}${Number(abs.toFixed(d))}`;
  if (!unit) return `${num} por hora`;
  return unit.endsWith('/h') ? `${num} ${unit} por hora` : `${num} ${unit}/h`;
}

/** Texto completo de la tendencia: «↗ subiendo +10 kW/h» o «→ estable». */
export function trendText(t: Trend | null, unit: string, decimals = 1): string {
  if (!t) return 'calculando…';
  return t.direction === 'steady'
    ? `${TREND_ARROW.steady} ${TREND_LABEL.steady}`
    : `${TREND_ARROW[t.direction]} ${TREND_LABEL[t.direction]} ${formatRate(t.perHour, unit, decimals)}`;
}

/** Último cambio del estado 0/1 visto en la serie: `{ at, running }`; `atLeast` si no hubo cambios en el buffer. */
export function lastStateChange(series: Series): { running: boolean; since: number; observedFrom: number; changed: boolean } | null {
  const n = series.v.length;
  if (n === 0) return null;
  const cur = series.v[n - 1]! >= 0.5;
  let since = series.t[0]!;
  let changed = false;
  for (let i = n - 1; i > 0; i--) {
    if ((series.v[i - 1]! >= 0.5) !== cur) {
      since = series.t[i]!;
      changed = true;
      break;
    }
  }
  return { running: cur, since, observedFrom: series.t[0]!, changed };
}

/** «hace 12 min» si se vio el cambio; «hace más de 6 min» si el estado ya era así al empezar a observar. */
export function sinceText(ms: number, changed: boolean): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const txt = s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return changed ? `hace ${txt}` : s < 15 ? 'recién visto' : `hace más de ${txt}`;
}
