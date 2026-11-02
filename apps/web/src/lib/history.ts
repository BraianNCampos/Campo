import { getToken } from './auth';
import { config } from './env';
import type { Series } from '@/store/history';

/**
 * Tendencia a un clic: ventanas de tiempo, cliente del histórico (`GET /api/plants/:plant/assets/:asset/history`,
 * docs/architecture.md §4) y mezcla del histórico con el búfer en vivo. Las funciones de ventana y mezcla son puras.
 */

export type WindowId = '15m' | '1h' | '6h' | '24h';

export interface TrendWindow {
  id: WindowId;
  label: string;
  ms: number;
  /** bucket de la API (≤ ~120 puntos por ventana) */
  bucket: '10s' | '30s' | '5m' | '15m';
}

export const TREND_WINDOWS: readonly TrendWindow[] = [
  { id: '15m', label: '15 min', ms: 15 * 60_000, bucket: '10s' },
  { id: '1h', label: '1 h', ms: 60 * 60_000, bucket: '30s' },
  { id: '6h', label: '6 h', ms: 6 * 60 * 60_000, bucket: '5m' },
  { id: '24h', label: '24 h', ms: 24 * 60 * 60_000, bucket: '15m' },
];

export const DEFAULT_WINDOW: WindowId = '1h';

export const windowById = (id: WindowId): TrendWindow => TREND_WINDOWS.find((w) => w.id === id) ?? TREND_WINDOWS[1]!;

/** Rango [from, to] de una ventana que termina en `now`. */
export function windowRange(id: WindowId, now: number): { from: number; to: number } {
  return { from: now - windowById(id).ms, to: now };
}

export interface HistoryPoint {
  t: number;
  avg: number;
  min?: number;
  max?: number;
}

/**
 * Mezcla histórico + vivo en una sola serie ordenada dentro de [from, to]. El búfer en vivo manda donde se solapa: se
 * descartan los puntos del histórico cuyo bucket (`t` … `t + bucketMs`) llega a la primera muestra en vivo. Valores no finitos se ignoran.
 */
export function mergeHistoryLive(history: readonly HistoryPoint[], live: Series, from: number, to: number, bucketMs = 0): Series {
  const pts: { t: number; v: number }[] = [];
  const liveStart = live.t.length ? live.t[0]! : Infinity;
  const cut = liveStart - bucketMs;
  for (const p of history) {
    if (Number.isFinite(p.t) && Number.isFinite(p.avg) && p.t <= cut && p.t >= from && p.t <= to) pts.push({ t: p.t, v: p.avg });
  }
  for (let i = 0; i < live.t.length; i++) {
    const t = live.t[i]!;
    const v = live.v[i]!;
    if (Number.isFinite(t) && Number.isFinite(v) && t >= from && t <= to) pts.push({ t, v });
  }
  pts.sort((a, b) => a.t - b.t);
  const t: number[] = [];
  const v: number[] = [];
  for (const p of pts) {
    if (t.length && t[t.length - 1] === p.t) v[v.length - 1] = p.v;
    else {
      t.push(p.t);
      v.push(p.v);
    }
  }
  return { t, v };
}

const BUCKET_MS = { '10s': 10_000, '30s': 30_000, '5m': 300_000, '15m': 900_000 } as const;
export const bucketMs = (w: TrendWindow): number => BUCKET_MS[w.bucket];

export class HistoryError extends Error {
  constructor(readonly status: number) {
    super(`history ${status}`);
  }
}

/** Sólo acepta puntos bien formados (`{t, avg}` numéricos). */
export function parseHistory(raw: unknown): HistoryPoint[] {
  const pts = (raw as { points?: unknown } | null)?.points;
  if (!Array.isArray(pts)) return [];
  return pts.filter((p): p is HistoryPoint => !!p && Number.isFinite((p as HistoryPoint).t) && Number.isFinite((p as HistoryPoint).avg));
}

/** Histórico de una métrica. En modo demo no hay API: devuelve `null` (se usa sólo el búfer en vivo). */
export async function loadHistory(
  q: { plant: string; asset: string; metric: string; from: number; to: number; bucket: TrendWindow['bucket'] },
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<HistoryPoint[] | null> {
  if (config.mock) return null;
  const token = getToken();
  const qs = new URLSearchParams({ metric: q.metric, from: String(Math.round(q.from)), to: String(Math.round(q.to)), bucket: q.bucket });
  let res: Response;
  try {
    res = await fetcher(`${config.apiUrl}/api/plants/${encodeURIComponent(q.plant)}/assets/${encodeURIComponent(q.asset)}/history?${qs}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal,
    });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    throw new HistoryError(0);
  }
  if (!res.ok) throw new HistoryError(res.status);
  return parseHistory(await res.json().catch(() => null));
}
