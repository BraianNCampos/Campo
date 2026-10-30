import type { ModuleId } from '@campo/shared';
import { countItems, type ModuleItem } from './summary';

export type KpiTone = 'neutral' | 'warn' | 'crit';

export interface Kpi {
  key: string;
  label: string;
  /** valor ya formateado ('—' si no hay datos) */
  value: string;
  unit?: string;
  hint?: string;
  /** el color sólo cuando importa: ámbar = atención, rojo = alarma */
  tone: KpiTone;
}

const NBSP = ' ';

/** Entero con separador de miles (espacio fino): 1 284 000. */
export function fmtInt(v: number): string {
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}
export function fmtNum(v: number | undefined, decimals = 1): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return decimals === 0 ? fmtInt(v) : v.toFixed(decimals);
}

const val = (i: ModuleItem, metric: string): number | undefined => {
  const v = i.state?.values[metric];
  return v !== undefined && Number.isFinite(v) && i.state?.quality !== 'bad' ? v : undefined;
};
const nums = (items: readonly ModuleItem[], metric: string) => items.map((i) => val(i, metric)).filter((v): v is number => v !== undefined);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : undefined);
const extreme = (items: readonly ModuleItem[], metric: string, pick: 'max' | 'min') => {
  let best: { v: number; name: string } | undefined;
  for (const i of items) {
    const v = val(i, metric);
    if (v === undefined) continue;
    if (!best || (pick === 'max' ? v > best.v : v < best.v)) best = { v, name: i.def.name };
  }
  return best;
};
const capacity = (i: ModuleItem): number | undefined => {
  const c = (i.def.metadata as { capacityM3?: unknown }).capacityM3;
  return typeof c === 'number' && c > 0 ? c : undefined;
};
const contracted = (i: ModuleItem): number | undefined => {
  const c = (i.def.metadata as { contractedKw?: unknown }).contractedKw;
  return typeof c === 'number' && c > 0 ? c : undefined;
};

const alarmKpi = (items: readonly ModuleItem[]): Kpi => {
  const n = countItems(items).alarm;
  return { key: 'alarm', label: 'En alarma', value: String(n), tone: n > 0 ? 'crit' : 'neutral' };
};
const nearKpi = (items: readonly ModuleItem[], label = 'Cerca del límite'): Kpi => {
  const n = countItems(items).near;
  return { key: 'near', label, value: String(n), tone: n > 0 ? 'warn' : 'neutral' };
};

type Builder = (items: readonly ModuleItem[]) => Kpi[];

const BUILDERS: Partial<Record<ModuleId, Builder>> = {
  tanks: (all) => {
    const items = all.filter((i) => i.def.type === 'tank');
    const total = sum(items.map((i) => capacity(i) ?? 0));
    const low = extreme(items, 'level', 'min');
    const c = countItems(all);
    return [
      { key: 'tanks', label: 'Tanques', value: String(items.length), tone: 'neutral' },
      { key: 'capacity', label: 'Capacidad total', value: fmtInt(total), unit: 'm³', tone: 'neutral' },
      { key: 'alarm', label: 'En alarma', value: String(c.alarm), tone: c.alarm > 0 ? 'crit' : 'neutral' },
      { key: 'near', label: 'Fuera o cerca del límite', value: String(c.near), tone: c.near > 0 ? 'warn' : 'neutral' },
      { key: 'lowest', label: 'Nivel más bajo', value: fmtNum(low?.v, 1), unit: low ? '%' : undefined, hint: low?.name, tone: 'neutral' },
    ];
  },
  climate: (items) => {
    const t = nums(items, 'temp');
    const hi = extreme(items, 'temp', 'max');
    const lo = extreme(items, 'temp', 'min');
    return [
      { key: 'sensors', label: 'Sensores', value: String(items.length), tone: 'neutral' },
      {
        key: 'temp', label: 'Temperatura promedio', value: fmtNum(avg(t), 1), unit: t.length ? '°C' : undefined,
        hint: hi && lo ? `máx ${fmtNum(hi.v)} · mín ${fmtNum(lo.v)} °C` : undefined, tone: 'neutral',
      },
      { key: 'humidity', label: 'Humedad promedio', value: fmtNum(avg(nums(items, 'humidity')), 0), unit: nums(items, 'humidity').length ? '%' : undefined, tone: 'neutral' },
      nearKpi(items),
      alarmKpi(items),
    ];
  },
  energy: (items) => {
    const kw = sum(nums(items, 'kw'));
    const hasKw = nums(items, 'kw').length > 0;
    const contr = sum(items.map((i) => contracted(i) ?? 0));
    const pf = avg(nums(items, 'pf'));
    return [
      { key: 'kw', label: 'Potencia activa total', value: hasKw ? fmtInt(kw) : '—', unit: hasKw ? 'kW' : undefined, tone: 'neutral' },
      {
        key: 'contracted', label: 'De la contratada', value: hasKw && contr > 0 ? fmtNum((kw / contr) * 100, 0) : '—',
        unit: hasKw && contr > 0 ? '%' : undefined, hint: contr > 0 ? `de ${fmtInt(contr)} kW` : undefined, tone: 'neutral',
      },
      { key: 'pf', label: 'Factor de potencia medio', value: fmtNum(pf, 2), tone: 'neutral' },
      nearKpi(items, 'Activos cerca del límite'),
      alarmKpi(items),
    ];
  },
  gas: (items) => {
    const flow = nums(items, 'flow');
    const total = nums(items, 'total');
    return [
      { key: 'flow', label: 'Caudal total', value: flow.length ? fmtNum(sum(flow), 1) : '—', unit: flow.length ? 'm³/h' : undefined, tone: 'neutral' },
      { key: 'total', label: 'Consumo acumulado', value: total.length ? fmtInt(sum(total)) : '—', unit: total.length ? 'm³' : undefined, tone: 'neutral' },
      { key: 'meters', label: 'Medidores', value: String(items.length), tone: 'neutral' },
      alarmKpi(items),
    ];
  },
  machines: (items) => {
    const on = items.filter((i) => val(i, 'state') !== undefined && val(i, 'state')! >= 0.5).length;
    const off = items.filter((i) => val(i, 'state') !== undefined && val(i, 'state')! < 0.5).length;
    return [
      { key: 'machines', label: 'Máquinas', value: String(items.length), tone: 'neutral' },
      { key: 'on', label: 'En marcha', value: String(on), tone: 'neutral' },
      { key: 'off', label: 'Detenidas', value: String(off), tone: 'neutral' },
      alarmKpi(items),
    ];
  },
  flow: (items) => {
    const hi = extreme(items, 'pressure', 'max');
    const lo = extreme(items, 'pressure', 'min');
    const flow = nums(items, 'flow');
    return [
      { key: 'pmax', label: 'Presión máxima', value: fmtNum(hi?.v, 1), unit: hi ? 'bar' : undefined, hint: hi?.name, tone: 'neutral' },
      { key: 'pmin', label: 'Presión mínima', value: fmtNum(lo?.v, 1), unit: lo ? 'bar' : undefined, hint: lo?.name, tone: 'neutral' },
      { key: 'flow', label: 'Caudal total', value: flow.length ? fmtNum(sum(flow), 1) : '—', unit: flow.length ? 'm³/h' : undefined, tone: 'neutral' },
      nearKpi(items),
      alarmKpi(items),
    ];
  },
};

/** Franja de resumen específica del módulo (4–5 números grandes). `view3d` no tiene. */
export function moduleKpis(module: ModuleId, items: readonly ModuleItem[]): Kpi[] {
  return BUILDERS[module]?.(items) ?? [];
}

export function sameKpis(a: readonly Kpi[], b: readonly Kpi[]): boolean {
  return a.length === b.length && a.every((k, i) => {
    const o = b[i]!;
    return k.key === o.key && k.value === o.value && k.unit === o.unit && k.hint === o.hint && k.tone === o.tone;
  });
}
