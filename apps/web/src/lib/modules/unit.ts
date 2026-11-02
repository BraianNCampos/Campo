import { ASSET_KINDS, METRICS, moduleForAssetType, type AssetDef, type AssetType, type ModuleId } from '@campo/shared';
import { parseConnectsTo } from '@/lib/catalog';
import { RUNNING_RPM } from '@/lib/assets';

/**
 * Detalle de la unidad (nivel 3, docs/architecture.md §14.2): variables del panel frontal (PV/SP/OP/MODE/STS), equipos
 * asociados y qué se puede ajustar. Funciones puras, sin React.
 */

/** Módulo desde el que se llega al detalle de un activo; `null` = no tiene detalle (estructuras, genéricos). */
export function unitModule(def: Pick<AssetDef, 'type'>): ModuleId | null {
  return def.type === 'structure' ? null : moduleForAssetType(def.type);
}

/** Tipos con motor (nivel 4: panel de motor). */
export const MOTOR_TYPES: readonly AssetType[] = ['pump', 'machine', 'conveyor'];
export const hasMotor = (type: AssetType): boolean => MOTOR_TYPES.includes(type);

/** Tipos cuyo setpoint de la métrica principal se puede ajustar (nivel 4, `engineer`+). */
export const SETPOINT_TYPES: readonly AssetType[] = ['tank', 'silo', 'climate', 'pressure'];
export const supportsSetpoint = (type: AssetType): boolean => SETPOINT_TYPES.includes(type);

export const MODE_LABEL: Record<number, string> = { 0: 'Manual', 1: 'Automático' };
export const STS_LABEL: Record<number, string> = { 0: 'Inactivo', 1: 'Llenando', 2: 'Vaciando', 3: 'En marcha', 4: 'Falla' };

export type StsTone = 'idle' | 'active' | 'fault';

export interface Sts {
  code: number | null;
  label: string;
  tone: StsTone;
}

/** STS: la métrica `sts` si existe; si no, se deduce (máquinas: `state`; bombas: rpm; válvulas: apertura). */
export function stsOf(def: Pick<AssetDef, 'type'> | undefined, values: Record<string, number> | undefined): Sts {
  const none: Sts = { code: null, label: '—', tone: 'idle' };
  if (!def || !values) return none;
  const v = values;
  if (typeof v.sts === 'number' && Number.isFinite(v.sts)) {
    const c = Math.round(v.sts);
    return { code: c, label: STS_LABEL[c] ?? `Estado ${c}`, tone: c === 4 ? 'fault' : c === 0 ? 'idle' : 'active' };
  }
  switch (def.type) {
    case 'machine':
    case 'conveyor':
      return v.state === undefined ? none : v.state >= 0.5 ? { code: 3, label: 'En marcha', tone: 'active' } : { code: 0, label: 'Detenida', tone: 'idle' };
    case 'pump':
      return v.rpm === undefined ? none : v.rpm > RUNNING_RPM ? { code: 3, label: 'En marcha', tone: 'active' } : { code: 0, label: 'Detenida', tone: 'idle' };
    case 'valve':
      return v.position === undefined ? none : { code: v.position > 2 ? 3 : 0, label: v.position < 2 ? 'Cerrada' : v.position > 98 ? 'Abierta' : 'Parcialmente abierta', tone: v.position < 2 ? 'idle' : 'active' };
    default:
      return none;
  }
}

/** MODE: la métrica `mode` (0 manual, 1 automático); `null` si no hay. */
export function modeOf(values: Record<string, number> | undefined): { code: number; label: string } | null {
  const m = values?.mode;
  if (typeof m !== 'number' || !Number.isFinite(m)) return null;
  const c = Math.round(m);
  return { code: c, label: MODE_LABEL[c] ?? `Modo ${c}` };
}

/** Vecinos de un activo: lo que él conecta, lo que lo conecta a él y, sin `connectsTo` en la planta, las cañerías de la demo. */
export function neighborIds(id: string, catalog: Record<string, AssetDef>, demoLinks: readonly (readonly [string, string])[] = []): string[] {
  const out = new Set<string>();
  const defs = Object.values(catalog);
  const anyLinks = defs.some((d) => parseConnectsTo(d.metadata).length > 0);
  if (anyLinks) {
    for (const t of parseConnectsTo(catalog[id]?.metadata)) out.add(t);
    for (const d of defs) if (parseConnectsTo(d.metadata).includes(id)) out.add(d.id);
  } else {
    for (const [a, b] of demoLinks) {
      if (a === id) out.add(b);
      if (b === id) out.add(a);
    }
  }
  out.delete(id);
  return [...out].filter((n) => n in catalog);
}

/**
 * Equipos y flujos asociados al activo: vecinos directos y, a través de una válvula o bomba, lo que está del otro lado
 * (un tanque ve su válvula y su bomba). Ordenados: válvulas, bombas, caudales, el resto.
 */
export function relatedAssets(id: string, catalog: Record<string, AssetDef>, demoLinks: readonly (readonly [string, string])[] = []): string[] {
  const direct = neighborIds(id, catalog, demoLinks);
  const seen = new Set<string>([id, ...direct]);
  const hop = (a: string) => neighborIds(a, catalog, demoLinks).filter((n) => !seen.has(n) && ['valve', 'pump'].includes(catalog[n]?.type ?? ''));
  const extra: string[] = [];
  for (const d of direct) if (['valve', 'pump'].includes(catalog[d]?.type ?? '')) for (const n of hop(d)) {
    if (seen.has(n)) continue;
    seen.add(n);
    extra.push(n);
  }
  const rank = (t: AssetType | undefined) => (t === 'valve' ? 0 : t === 'pump' ? 1 : t === 'flow' || t === 'gas' ? 2 : 3);
  return [...direct, ...extra].sort((a, b) => rank(catalog[a]?.type) - rank(catalog[b]?.type) || a.localeCompare(b, 'en', { numeric: true }));
}

/** Resumen de una línea del estado de un activo asociado. */
export function relatedSummary(def: Pick<AssetDef, 'type'>, values: Record<string, number> | undefined): string {
  const v = values;
  if (!v) return 'Sin datos';
  const n = (x: number, d = 0) => x.toFixed(d).replace('.', ',');
  switch (def.type) {
    case 'valve':
      return v.position === undefined ? 'Sin datos' : `${v.position < 2 ? 'Cerrada' : v.position > 98 ? 'Abierta' : 'Abierta parcialmente'} · ${n(v.position)} %`;
    case 'pump':
      return v.rpm === undefined ? 'Sin datos' : `${v.rpm > RUNNING_RPM ? 'En marcha' : 'Detenida'}${v.rpm > RUNNING_RPM ? ` · ${n(v.rpm)} rpm` : ''}`;
    case 'flow':
    case 'gas':
      return v.flow === undefined ? 'Sin datos' : `${n(v.flow, 1)} m³/h${v.total !== undefined ? ` · acumulado ${n(v.total)} m³` : ''}`;
    case 'tank':
    case 'silo':
      return v.level === undefined ? 'Sin datos' : `Nivel ${n(v.level, 1)} %`;
    default: {
      const k = ASSET_KINDS[def.type]?.primaryMetric;
      const m = k ? METRICS[k] : undefined;
      return k && v[k] !== undefined ? `${n(v[k]!, m?.decimals ?? 1)}${m?.unit ? ` ${m.unit}` : ''}` : 'Sin datos';
    }
  }
}

export interface Faceplate {
  pv: { metric: string; value: number | undefined };
  sp: number | undefined;
  /** salida en % (métrica `op` o apertura de la válvula asociada) */
  op: { value: number; source: 'op' | 'valve' } | null;
  mode: { code: number; label: string } | null;
  sts: Sts;
}

/** Variables del panel frontal. `valveValues`: valores de la válvula asociada (para OP si no hay `op`). */
export function faceplateOf(
  def: Pick<AssetDef, 'type'> | undefined,
  values: Record<string, number> | undefined,
  setpoint: number | undefined,
  valveValues?: Record<string, number>,
): Faceplate {
  const metric = def ? ASSET_KINDS[def.type].primaryMetric : 'value';
  let op: Faceplate['op'] = null;
  if (typeof values?.op === 'number' && Number.isFinite(values.op)) op = { value: values.op, source: 'op' };
  else if (def?.type === 'valve' && values?.position !== undefined) op = { value: values.position, source: 'valve' };
  else if (valveValues?.position !== undefined) op = { value: valveValues.position, source: 'valve' };
  return { pv: { metric, value: values?.[metric] }, sp: setpoint, op, mode: modeOf(values), sts: stsOf(def, values) };
}
