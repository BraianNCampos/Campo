import type { AssetDef } from '@campo/shared';
import type { Series } from '@/store/history';
import { slopePerHour, lastStateChange, sinceText } from './trend';
import { fmtInt, fmtNum } from './kpis';

export interface Extra {
  label: string;
  value: string;
}

export interface ExtraInput {
  def: Pick<AssetDef, 'type' | 'metadata'>;
  values: Record<string, number>;
  series(metric: string): Series;
  now: number;
}

/** Umbral de caudal para decir «llenando»/«vaciando» en lugar de «sin movimiento» (m³/h). */
export const FLOW_EPSILON_M3H = 0.05;

const md = (def: Pick<AssetDef, 'metadata'>, key: string): number | undefined => {
  const v = (def.metadata as Record<string, unknown>)[key];
  return typeof v === 'number' && v > 0 ? v : undefined;
};

/** Volumen de un tanque (m³) = nivel × capacidad. */
export const tankVolume = (levelPct: number, capacityM3: number): number => (levelPct / 100) * capacityM3;

/** Caudal de llenado (+) o vaciado (−) en m³/h derivado de la pendiente del nivel. */
export function tankFlowM3h(levelSeries: Series, capacityM3: number, now?: number): number | null {
  const s = slopePerHour(levelSeries, now);
  return s === null ? null : (s / 100) * capacityM3;
}

/** Datos del pie de cada tarjeta según el tipo (docs/architecture.md §11.4). */
export function cardExtras(i: ExtraInput): Extra[] {
  const v = i.values;
  switch (i.def.type) {
    case 'tank': {
      const out: Extra[] = [];
      const cap = md(i.def, 'capacityM3');
      if (cap !== undefined && v.level !== undefined) {
        out.push({ label: 'Volumen', value: `${fmtNum(tankVolume(v.level, cap), 1)} m³ de ${fmtInt(cap)}` });
        const q = tankFlowM3h(i.series('level'), cap, i.now);
        if (q !== null) {
          out.push({
            label: q > FLOW_EPSILON_M3H ? 'Llenando' : q < -FLOW_EPSILON_M3H ? 'Vaciando' : 'Caudal',
            value: Math.abs(q) <= FLOW_EPSILON_M3H ? 'sin movimiento' : `${fmtNum(Math.abs(q), Math.abs(q) >= 100 ? 0 : 1)} m³/h`,
          });
        }
      }
      if (v.temp !== undefined) out.push({ label: 'Temperatura', value: `${fmtNum(v.temp)} °C` });
      return out;
    }
    case 'climate': {
      const out: Extra[] = [];
      if (v.temp !== undefined) out.push({ label: 'Temperatura', value: `${fmtNum(v.temp)} °C` });
      if (v.humidity !== undefined) out.push({ label: 'Humedad', value: `${fmtNum(v.humidity, 0)} %` });
      return out;
    }
    case 'energy': {
      const out: Extra[] = [];
      const kw = i.series('kw').v;
      if (kw.length >= 2) out.push({ label: 'Mín–máx recientes', value: `${fmtInt(Math.min(...kw))}–${fmtInt(Math.max(...kw))} kW` });
      const c = md(i.def, 'contractedKw');
      if (c !== undefined && v.kw !== undefined) out.push({ label: 'De la contratada', value: `${fmtNum((v.kw / c) * 100, 0)} % de ${fmtInt(c)} kW` });
      if (v.pf !== undefined) out.push({ label: 'Factor de potencia', value: fmtNum(v.pf, 2) });
      return out;
    }
    case 'gas':
      return v.total !== undefined ? [{ label: 'Acumulado', value: `${fmtInt(v.total)} m³` }] : [];
    case 'machine': {
      if (v.state === undefined) return [];
      const ch = lastStateChange(i.series('state'));
      const run = v.state >= 0.5;
      return [{ label: run ? 'En marcha' : 'Detenida', value: ch ? sinceText(i.now - ch.since, ch.changed) : '' }].filter((e) => e.value !== '');
    }
    case 'pump': {
      const out: Extra[] = [];
      if (v.rpm !== undefined) out.push({ label: v.rpm > 50 ? 'En marcha' : 'Detenida', value: '' });
      if (v.current !== undefined) out.push({ label: 'Corriente', value: `${fmtNum(v.current)} A` });
      return out.filter((e) => e.value !== '' || e.label === 'En marcha' || e.label === 'Detenida');
    }
    case 'valve':
      return v.position === undefined ? [] : [{ label: 'Estado', value: v.position < 2 ? 'Cerrada' : v.position > 98 ? 'Abierta' : 'Parcialmente abierta' }];
    default:
      return [];
  }
}
