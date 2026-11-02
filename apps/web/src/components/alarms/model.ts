import { METRICS, moduleForAssetType, type AlarmEvent, type AlarmKind, type AssetDef, type ModuleId, type Severity } from '@campo/shared';
import { assetLabel } from '@/lib/assets';
import { formatAgo } from '@/lib/math';
import { lifecycleOf, type LiveAlarm } from '@/lib/alarm-lifecycle';

/** Lógica pura de la lista de alarmas (`/alarmas`): filtros, orden, textos y enlaces. Sin React. */

export type AlarmTab = 'active' | 'shelved' | 'history';

export interface AlarmFilters {
  module: ModuleId | '';
  severity: Severity | '';
  kind: AlarmKind | '';
  /** texto libre: activo (nombre o id), descripción o magnitud */
  query: string;
}

export const EMPTY_FILTERS: AlarmFilters = { module: '', severity: '', kind: '', query: '' };
export const hasFilters = (f: AlarmFilters) => !!(f.module || f.severity || f.kind || f.query.trim());

export const ALL_KINDS: readonly AlarmKind[] = ['HH', 'HI', 'LO', 'LL', 'DEV', 'ROC'];

export const KIND_LABEL: Record<AlarmKind, string> = {
  HH: 'Muy alto',
  HI: 'Alto',
  LO: 'Bajo',
  LL: 'Muy bajo',
  DEV: 'Desviación',
  ROC: 'Cambio brusco',
};

export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Crítica', warning: 'Advertencia' };

/** Tipo de la alarma; si el servidor aún no lo informa, se deduce de la prioridad y de cómo está el valor respecto del límite. */
export function effectiveKind(a: Pick<AlarmEvent, 'kind' | 'severity' | 'value' | 'threshold'>): AlarmKind {
  if (a.kind) return a.kind;
  const high = a.value >= a.threshold;
  return high ? (a.severity === 'critical' ? 'HH' : 'HI') : a.severity === 'critical' ? 'LL' : 'LO';
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface FilterCtx {
  catalog: Record<string, AssetDef>;
}

export const assetNameOf = (id: string, catalog: Record<string, AssetDef>) => catalog[id]?.name ?? assetLabel(id);

export function alarmModule(a: Pick<AlarmEvent, 'asset'>, catalog: Record<string, AssetDef>): ModuleId | null {
  const t = catalog[a.asset]?.type;
  return t ? moduleForAssetType(t) : null;
}

/** Texto principal: la descripción de la racionalización o, si no hay, el mensaje del servidor. */
export const alarmTitle = (a: Pick<AlarmEvent, 'rationale' | 'message' | 'metric'>): string =>
  a.rationale?.description?.trim() || a.message.trim() || `${METRICS[a.metric]?.label ?? a.metric} fuera de límite`;

export function matchesQuery(a: AlarmEvent, query: string, ctx: FilterCtx): boolean {
  const q = norm(query.trim());
  if (!q) return true;
  const hay = norm([a.asset, ctx.catalog[a.asset]?.tag ?? '', assetNameOf(a.asset, ctx.catalog), alarmTitle(a), METRICS[a.metric]?.label ?? a.metric].join(' '));
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export function filterAlarms<T extends AlarmEvent>(list: readonly T[], f: AlarmFilters, ctx: FilterCtx): T[] {
  return list.filter((a) => {
    if (f.severity && a.severity !== f.severity) return false;
    if (f.kind && effectiveKind(a) !== f.kind) return false;
    if (f.module && alarmModule(a, ctx.catalog) !== f.module) return false;
    return matchesQuery(a, f.query, ctx);
  });
}

/** Prioridad (críticas primero) y, dentro de cada una, la más antigua primero: la que más lleva esperando. */
export function orderAlarms<T extends AlarmEvent>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) => (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0) || a.ts - b.ts || a.id.localeCompare(b.id),
  );
}

/** Historial: lo más reciente primero. */
export const orderHistory = <T extends AlarmEvent>(list: readonly T[]): T[] => [...list].sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));

/** Postergadas: las que vencen antes primero. */
export const orderShelved = <T extends AlarmEvent>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => (a.shelvedUntil ?? Infinity) - (b.shelvedUntil ?? Infinity) || a.id.localeCompare(b.id));

// ── Textos ──

export function unitOf(metric: string): string {
  return METRICS[metric]?.unit ?? '';
}
const num = (v: number, metric: string) => v.toFixed(METRICS[metric]?.decimals ?? 1);
export const valueText = (a: Pick<AlarmEvent, 'value' | 'metric'>) => `${num(a.value, a.metric)}${unitOf(a.metric) ? ` ${unitOf(a.metric)}` : ''}`;

/** Límite según el tipo: `> 90 %`, `< 10 %`, `± 6 °C del SP` (desviación) o `2 %/min` (tasa de cambio). */
export function limitText(a: Pick<AlarmEvent, 'kind' | 'severity' | 'value' | 'threshold' | 'metric'>): string {
  const k = effectiveKind(a);
  const u = unitOf(a.metric);
  const t = `${a.threshold}${u ? ` ${u}` : ''}`;
  if (k === 'DEV') return `± ${t} del SP`;
  if (k === 'ROC') return `${a.threshold}${u ? ` ${u}` : ''}/min`;
  return `${k === 'HH' || k === 'HI' ? '>' : '<'} ${t}`;
}

/** «hace 5 min» desde que se activó; normalizadas: «normalizó hace…». */
export function timeText(a: LiveAlarm, now: number): string {
  const l = lifecycleOf(a);
  if (l === 'rtn_unacked') return `normalizó ${formatAgo(now - (a.clearedAt ?? a.ts))}`;
  if (l === 'closed') return `cerró ${formatAgo(now - (a.clearedAt ?? a.ts))}`;
  return formatAgo(now - a.ts);
}

export function remainingText(until: number | undefined, now: number): string {
  if (until === undefined) return '';
  const ms = until - now;
  if (ms <= 0) return 'vence ahora';
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `vuelve en ${min} min`;
  const h = Math.floor(min / 60);
  return `vuelve en ${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

/** Enlace a la tendencia del activo: el módulo que lo contiene (si el cliente lo tiene) con `?trend=activo:métrica`. */
export function trendHref(a: Pick<AlarmEvent, 'asset' | 'metric'>, catalog: Record<string, AssetDef>, activeModules: readonly ModuleId[]): string | null {
  const m = alarmModule(a, catalog);
  if (!m || !activeModules.includes(m)) return null;
  return `/m/${m}?trend=${encodeURIComponent(`${a.asset}:${a.metric}`)}`;
}

/** Módulos que tienen alguna alarma de la lista (para el filtro). */
export function modulesIn(list: readonly AlarmEvent[], catalog: Record<string, AssetDef>): ModuleId[] {
  const out = new Set<ModuleId>();
  for (const a of list) {
    const m = alarmModule(a, catalog);
    if (m) out.add(m);
  }
  return [...out];
}
