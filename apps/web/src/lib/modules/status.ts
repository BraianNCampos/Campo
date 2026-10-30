import type { AlarmEvent, AssetDef, AssetState, Limit, Severity } from '@campo/shared';
import { ASSET_KINDS } from '@campo/shared';
import { resolveScale, type Scale } from './scale';

/**
 * Fracción de la distancia (setpoint → límite de alarma) a partir de la cual un valor está «cerca del límite»
 * (ISA-101, docs/ux-isa.md §2.3): ámbar al llegar al 90 % del camino.
 */
export const NEAR_FRACTION = 0.9;

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

const isUpper = (l: Pick<Limit, 'operator'>) => l.operator === 'gt' || l.operator === 'gte';

/** Punto de partida de la distancia: el setpoint si está del lado normal del límite; si no, el extremo de la escala. */
export function limitOrigin(limit: Pick<Limit, 'operator' | 'threshold'>, setpoint: number | undefined, scale: Scale | undefined): number | undefined {
  if (setpoint !== undefined && Number.isFinite(setpoint) && (isUpper(limit) ? setpoint < limit.threshold : setpoint > limit.threshold)) return setpoint;
  if (!scale) return undefined;
  return isUpper(limit) ? scale.min : scale.max;
}

/**
 * «Cerca del límite» (ISA-101): el valor aún no cruzó el límite pero ya recorrió el 90 % o más de la distancia que
 * va del setpoint al límite de alarma. Sin setpoint (`metadata.setpoints[métrica]` o la métrica `sp`) la distancia
 * se mide desde el mínimo de la escala (límites superiores) o su máximo (límites inferiores). Sin setpoint ni escala
 * no se puede decidir → false.
 */
export function isNearLimit(
  value: number,
  limits: readonly Limit[],
  scale: Scale | undefined,
  setpoint?: number,
  fraction = NEAR_FRACTION,
): boolean {
  if (!Number.isFinite(value)) return false;
  return limits.some((l) => {
    if (beyondLimit(value, l)) return false;
    const origin = limitOrigin(l, setpoint, scale);
    if (origin === undefined) return false;
    const total = Math.abs(l.threshold - origin);
    if (!(total > 0)) return false;
    const done = isUpper(l) ? value - origin : origin - value;
    return done / total >= fraction - 1e-9;
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

/**
 * Setpoint de una métrica: `metadata.setpoints[métrica]`; si no, la métrica `sp` de la telemetría cuando se trata
 * de la métrica principal del activo.
 */
export function setpointOf(
  def: Pick<AssetDef, 'metadata' | 'type'> | undefined,
  values: Record<string, number> | undefined,
  metric: string,
): number | undefined {
  const sps = (def?.metadata as { setpoints?: unknown } | undefined)?.setpoints;
  const own = sps && typeof sps === 'object' ? (sps as Record<string, unknown>)[metric] : undefined;
  if (typeof own === 'number' && Number.isFinite(own)) return own;
  const sp = values?.sp;
  if (def && metric === ASSET_KINDS[def.type].primaryMetric && typeof sp === 'number' && Number.isFinite(sp)) return sp;
  return undefined;
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
 * pasado de) un límite (regla del 90 % setpoint→límite) → Cerca del límite; si no, En rango. Un activo con datos que no figura en el catálogo → No catalogado.
 */
export function cardStatus(i: StatusInput): CardStatus {
  if (!i.state || i.state.quality === 'bad') return 'nodata';
  if (!i.def && i.catalogReady) return 'uncataloged';
  if (i.alarmSeverity) return 'alarm';
  const byMetric = limitsByMetric(i.limits);
  for (const [metric, ls] of Object.entries(byMetric)) {
    const v = i.state.values[metric];
    if (v === undefined) continue;
    if (isBeyondAnyLimit(v, ls) || isNearLimit(v, ls, resolveScale(i.def, metric, ls), setpointOf(i.def, i.state.values, metric))) return 'near';
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
