import { ASSET_KINDS, METRICS, type AssetDef, type AssetState, type Limit } from '@campo/shared';
import type { RefLine } from '../LineChart';
import { limitTag } from '@/lib/modules/deviation';

/** Métrica principal primero y luego las demás del tipo que ya tienen dato (selector de métrica secundaria). */
export function trendMetrics(def: Pick<AssetDef, 'type'> | undefined, state: AssetState | undefined, primary: string): string[] {
  const out = [primary];
  for (const m of def ? ASSET_KINDS[def.type].metrics : []) {
    if (m !== primary && METRICS[m] && state?.values[m] !== undefined) out.push(m);
  }
  return out;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));

/** Líneas de la curva: SP (si hay) y cada límite de alarma de la métrica, rotulados con su tipo (HH, HI, LO, LL). */
export function trendRefLines(limits: readonly Limit[], setpoint: number | undefined): RefLine[] {
  const out: RefLine[] = [];
  if (setpoint !== undefined && Number.isFinite(setpoint)) out.push({ value: setpoint, label: `SP ${fmt(setpoint)}`, kind: 'sp' });
  for (const l of limits) {
    if (Number.isFinite(l.threshold)) out.push({ value: l.threshold, label: `${limitTag(l)} ${fmt(l.threshold)}`, kind: l.severity });
  }
  return out;
}
