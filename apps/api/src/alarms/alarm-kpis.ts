import type { AlarmKind, AlarmKpis, AlarmPolicy, Severity } from '@campo/shared';

/** Ventanas admitidas y su duración en días (perDay = total / días). */
export const KPI_WINDOWS: Record<AlarmKpis['window'], number> = { '24h': 1, '7d': 7, '30d': 30 };
export const DAY_MS = 86_400_000;
/** Ventana deslizante de EEMUA 191 para el pico y la intermitencia: [t, t + 10 min). */
export const TEN_MIN_MS = 600_000;
export const CHATTER_MIN = 3;
export const TOP_N = 10;
export const LIST_CAP = 50;

/** Una activación (fila de `alarms`) reducida a lo que necesitan los KPIs. */
export interface Activation {
  ruleId: string;
  asset: string;
  metric: string;
  kind: AlarmKind;
  severity: Severity;
  ts: number;
}

/** Parte del resultado que sale de la base de datos (el servicio añade política, tasas y estado). */
export interface HealthData {
  total: number;
  byPriority: { critical: number; warning: number };
  peak10min: { count: number; at: number | null };
  top: AlarmKpis['top'];
  chattering: AlarmKpis['chattering'];
  stale: AlarmKpis['stale'];
  shelved: number;
  suppressed: number;
  outOfService: number;
}

/** Máximo de elementos en cualquier ventana [t, t+10min) que empiece en uno de ellos; `at` = primer inicio. */
export function maxInWindow(sortedTimes: number[]): { count: number; at: number | null } {
  let best = 0;
  let at: number | null = null;
  let j = 0;
  for (let i = 0; i < sortedTimes.length; i++) {
    if (j < i) j = i;
    while (j < sortedTimes.length && sortedTimes[j] < sortedTimes[i] + TEN_MIN_MS) j++;
    if (j - i > best) {
      best = j - i;
      at = sortedTimes[i];
    }
  }
  return { count: best, at };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Cálculo de referencia de los KPIs de activaciones. La base de datos lo hace con SQL (ventanas); esta versión
 * la usan los repositorios en memoria y fija el significado exacto de cada número.
 */
export function summarizeActivations(
  rows: Activation[],
): Pick<HealthData, 'total' | 'byPriority' | 'peak10min' | 'top' | 'chattering'> {
  const byPair = new Map<string, Activation[]>();
  for (const r of rows) {
    const k = `${r.ruleId}|${r.asset}`;
    const g = byPair.get(k);
    if (g) g.push(r);
    else byPair.set(k, [r]);
  }
  const top = [...byPair.values()]
    .map((g) => ({
      ruleId: g[0].ruleId,
      asset: g[0].asset,
      metric: g[0].metric,
      kind: g[0].kind,
      count: g.length,
    }))
    .sort((a, b) => b.count - a.count || cmp(a.asset, b.asset) || cmp(a.ruleId, b.ruleId))
    .slice(0, TOP_N);
  const chattering = [...byPair.values()]
    .map((g) => ({
      ruleId: g[0].ruleId,
      asset: g[0].asset,
      metric: g[0].metric,
      activations10min: maxInWindow(g.map((r) => r.ts).sort((a, b) => a - b)).count,
    }))
    .filter((c) => c.activations10min >= CHATTER_MIN)
    .sort(
      (a, b) =>
        b.activations10min - a.activations10min || cmp(a.asset, b.asset) || cmp(a.ruleId, b.ruleId),
    )
    .slice(0, LIST_CAP);
  return {
    total: rows.length,
    byPriority: {
      critical: rows.filter((r) => r.severity === 'critical').length,
      warning: rows.filter((r) => r.severity === 'warning').length,
    },
    peak10min: maxInWindow(rows.map((r) => r.ts).sort((a, b) => a - b)),
    top,
    chattering,
  };
}

/**
 * ok si cumple la política; warning hasta 1,5x el objetivo; critical por encima. Se toma la peor de las dos
 * medidas (tasa diaria y pico de 10 minutos).
 */
export function kpiStatus(perDay: number, peak: number, policy: AlarmPolicy): AlarmKpis['status'] {
  const ratio = Math.max(perDay / policy.ratePerDay, peak / policy.peak10min);
  if (ratio <= 1) return 'ok';
  return ratio <= 1.5 ? 'warning' : 'critical';
}
