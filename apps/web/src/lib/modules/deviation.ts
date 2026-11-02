import type { AlarmKind, Limit } from '@campo/shared';
import { NEAR_FRACTION } from './status';
import type { Scale } from './scale';

/**
 * Modelo de la barra de desviación (ISA-101, docs/ux-isa.md §2.3): el cero es el setpoint y los extremos son los
 * límites de alarma más cercanos de cada lado. Todo es puro; `DeviationBar` sólo lo dibuja.
 */

export type DeviationState = 'ok' | 'near' | 'alarm' | 'nodata';

export interface DeviationEnd {
  /** posición del extremo en unidades de la métrica */
  at: number;
  /** límite de alarma que lo define; `undefined` = extremo de la escala */
  limit?: Limit;
  /** rótulo corto: HH, HI, LO, LL (vacío si es el extremo de la escala) */
  tag: string;
}

export interface DeviationModel {
  setpoint: number;
  /** extremo izquierdo (bajo) y derecho (alto) */
  low: DeviationEnd;
  high: DeviationEnd;
  /** valor − SP; `undefined` si no hay valor válido */
  offset: number | undefined;
  /** posición normalizada −1 (límite bajo) … +1 (límite alto), acotada; 0 si no hay valor */
  pos: number;
  side: 'above' | 'below' | 'at';
  /** fracción de la distancia SP→límite del lado en que está el valor (sólo si ese lado tiene límite) */
  fraction: number | undefined;
  /** el valor está más allá del extremo (pos acotada) */
  beyond: boolean;
  state: DeviationState;
}

export interface DeviationInput {
  value: number | undefined;
  setpoint: number | undefined;
  limits: readonly Limit[];
  scale: Scale | undefined;
  /** hay una alarma activa de esta métrica (el rojo lo decide la alarma, no el cruce) */
  alarm?: boolean;
  fraction?: number;
}

const isUpper = (l: Pick<Limit, 'operator'>) => l.operator === 'gt' || l.operator === 'gte';
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Rótulo del límite: el tipo de la regla si viene en el contrato; si no, se deriva del operador y la severidad. */
export function limitTag(l: Pick<Limit, 'operator' | 'severity'> & { kind?: AlarmKind }): string {
  if (l.kind) return l.kind;
  return isUpper(l) ? (l.severity === 'critical' ? 'HH' : 'HI') : l.severity === 'critical' ? 'LL' : 'LO';
}

/** Límite más cercano al SP de un lado (se ignoran los que están del lado equivocado del SP). */
function nearest(limits: readonly Limit[], sp: number, upper: boolean): Limit | undefined {
  let best: Limit | undefined;
  for (const l of limits) {
    if (!fin(l.threshold) || isUpper(l) !== upper) continue;
    if (upper ? !(l.threshold > sp) : !(l.threshold < sp)) continue;
    if (!best || Math.abs(l.threshold - sp) < Math.abs(best.threshold - sp)) best = l;
  }
  return best;
}

/**
 * Modelo de la barra, o `null` si no se puede centrar en un SP (sin SP, SP no finito o fuera de la escala): en ese caso
 * se mantiene la barra de rango. Sin límite de un lado, ese extremo es el de la escala.
 */
export function deviationModel(i: DeviationInput): DeviationModel | null {
  const { setpoint: sp, scale } = i;
  if (!fin(sp) || !scale || !fin(scale.min) || !fin(scale.max) || !(scale.min < scale.max)) return null;
  if (sp < scale.min || sp > scale.max) return null;
  const fraction = i.fraction ?? NEAR_FRACTION;

  const lo = nearest(i.limits, sp, false);
  const hi = nearest(i.limits, sp, true);
  const low: DeviationEnd = lo ? { at: lo.threshold, limit: lo, tag: limitTag(lo) } : { at: Math.min(scale.min, sp), tag: '' };
  const high: DeviationEnd = hi ? { at: hi.threshold, limit: hi, tag: limitTag(hi) } : { at: Math.max(scale.max, sp), tag: '' };

  const v = i.value;
  if (!fin(v)) return { setpoint: sp, low, high, offset: undefined, pos: 0, side: 'at', fraction: undefined, beyond: false, state: 'nodata' };

  const offset = v - sp;
  const side = offset > 0 ? 'above' : offset < 0 ? 'below' : 'at';
  const end = side === 'below' ? low : high;
  const dist = Math.abs(end.at - sp);
  const ratio = side === 'at' ? 0 : dist > 0 ? Math.abs(offset) / dist : Infinity;
  const pos = (side === 'below' ? -1 : 1) * Math.min(1, ratio);
  const sideFraction = end.limit && side !== 'at' ? ratio : undefined;
  const near = sideFraction !== undefined && sideFraction >= fraction - 1e-9;
  return {
    setpoint: sp, low, high, offset, pos, side,
    fraction: sideFraction,
    beyond: ratio > 1,
    state: i.alarm ? 'alarm' : near ? 'near' : 'ok',
  };
}

/** Texto accesible: «a 3,2 % por encima del SP (60 %)». */
export function deviationText(m: DeviationModel, unit: string, decimals: number): string {
  const f = (n: number) => `${n.toLocaleString('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${unit ? ` ${unit}` : ''}`;
  if (m.offset === undefined) return 'sin datos';
  const abs = Math.abs(m.offset);
  if (m.side === 'at' || Number(abs.toFixed(decimals)) === 0) return `en el SP (${f(m.setpoint)})`;
  return `a ${f(abs)} por ${m.side === 'above' ? 'encima' : 'debajo'} del SP (${f(m.setpoint)})`;
}
