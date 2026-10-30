import type { AlarmEvent, AssetDef, AssetState, Limit, Severity } from '@campo/shared';
import { ASSET_KINDS } from '@campo/shared';
import { resolveScale, type Scale } from './scale';

/** Fracción de la escala que define «cerca del límite». */
export const NEAR_FRACTION = 0.1;

/** Estado de una tarjeta de módulo. */
export type CardStatus = 'ok' | 'near' | 'alarm' | 'nodata' | 'uncataloged';

export const CARD_STATUS_LABEL: Record<CardStatus, string> = {
  ok: 'En rango',
  near: 'Cerca del límite',
  alarm: 'Alarma',
  nodata: 'Sin datos',
  uncataloged: 'No catalogado',
};

/** Estados que «requieren atención». */
export const needsAttention = (s: CardStatus): boolean => s === 'near' || s === 'alarm';

/** ¿El valor ya está del lado peligroso del umbral? */
export function beyondLimit(value: number, limit: Pick<Limit, 'operator' | 'threshold'>): boolean {
  switch (limit.operator) {
    case 'gt': return value > limit.threshold;
    case 'gte': return value >= limit.threshold;
    case 'lt': return value < limit.threshold;
    case 'lte': return value <= limit.threshold;
  }
}

/**
 * «Cerca del límite»: el valor aún no cruzó el umbral pero está a menos del 10 % de la escala de él, en la
 * dirección peligrosa (por debajo de un `gt/gte`, por encima de un `lt/lte`). Sin escala no se puede decidir → false.
 */
export function isNearLimit(value: number, limits: readonly Limit[], scale: Scale | undefined, fraction = NEAR_FRACTION): boolean {
  if (!scale || !Number.isFinite(value)) return false;
  const span = scale.max - scale.min;
  if (!(span > 0)) return false;
  return limits.some((l) => {
    if (beyondLimit(value, l)) return false;
    const gap = l.operator === 'gt' || l.operator === 'gte' ? l.threshold - value : value - l.threshold;
    return gap < span * fraction;
  });
}

/** ¿Algún límite ya cruzado? (la alarma llega con su retardo `forSeconds`; mientras tanto, «en el límite»). */
export const isBeyondAnyLimit = (value: number, limits: readonly Limit[]): boolean => limits.some((l) => beyondLimit(value, l));

/** Límites de un activo agrupados por métrica. */
export function limitsByMetric(limits: readonly Limit[]): Record<string, Limit[]> {
  const out: Record<string, Limit[]> = {};
  for (const l of limits) (out[l.metric] ??= []).push(l);
  return out;
}

export function groupLimitsByAsset(limits: readonly Limit[]): Record<string, Limit[]> {
  const out: Record<string, Limit[]> = {};
  for (const l of limits) (out[l.asset] ??= []).push(l);
  return out;
}

export interface StatusInput {
  /** `undefined` = el activo no está en el catálogo */
  def: Pick<AssetDef, 'metadata' | 'type'> | undefined;
  /** el catálogo ya se cargó (sólo entonces se afirma «No catalogado») */
  catalogReady?: boolean;
  state: AssetState | undefined;
  alarmSeverity: Severity | undefined;
  /** límites del activo (todas sus métricas) */
  limits: readonly Limit[];
}

/**
 * Estado de tarjeta: sin telemetría (o calidad mala) → Sin datos; alarma activa → Alarma; algún valor cerca de (o
 * pasado de) un límite → Cerca del límite; si no, En rango. Un activo con datos que no figura en el catálogo → No catalogado.
 */
export function cardStatus(i: StatusInput): CardStatus {
  if (!i.state || i.state.quality === 'bad') return 'nodata';
  if (!i.def && i.catalogReady) return 'uncataloged';
  if (i.alarmSeverity) return 'alarm';
  const byMetric = limitsByMetric(i.limits);
  for (const [metric, ls] of Object.entries(byMetric)) {
    const v = i.state.values[metric];
    if (v === undefined) continue;
    if (isBeyondAnyLimit(v, ls) || isNearLimit(v, ls, resolveScale(i.def, metric, ls))) return 'near';
  }
  return 'ok';
}

/** Severidad máxima de las alarmas activas de un activo (para colorear: crítica roja, advertencia ámbar). */
export function alarmSeverityOf(alarms: Record<string, AlarmEvent>, asset: string): Severity | undefined {
  let sev: Severity | undefined;
  for (const a of Object.values(alarms)) {
    if (a.asset !== asset) continue;
    if (a.severity === 'critical') return 'critical';
    sev = 'warning';
  }
  return sev;
}

export const primaryMetricOf = (def: Pick<AssetDef, 'type'>): string => ASSET_KINDS[def.type].primaryMetric;
