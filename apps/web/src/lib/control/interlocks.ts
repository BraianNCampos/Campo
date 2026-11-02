import type { AlarmEvent, AssetDef, AssetState, ControlConfig, InterlockItem, Limit, Order, OrderCommand, Role } from '@campo/shared';
import { isActiveCondition } from '@/lib/alarm-lifecycle';
import { CONTROL_DEFAULTS, HI_MARGIN, STALE_TELEMETRY_MS, isActiveOrder } from './types';

/**
 * Lógica de enclavamientos (docs/architecture.md §14.3) para la interfaz y para el mock del modo demo. La API es la
 * autoridad: la web solo muestra por qué una orden no se puede dar y deja que el servidor decida; `stop` siempre se
 * permite a `operator`+ aunque haya otros enclavamientos.
 */

export const ORDER_ROLES: readonly Role[] = ['platform_admin', 'admin', 'engineer', 'operator'];
export const SETPOINT_ROLES: readonly Role[] = ['platform_admin', 'admin', 'engineer'];

/** ¿Puede el rol dar órdenes? (`viewer` solo lee.) */
export const canOrder = (role: Role | null | undefined): boolean => !!role && ORDER_ROLES.includes(role);
/** Nivel 4 (diagnóstico y mantenimiento): `operator`+. */
export const canSeeEquipment = canOrder;
/** Cambiar setpoints: `engineer`+. */
export const canEditSetpoint = (role: Role | null | undefined): boolean => !!role && SETPOINT_ROLES.includes(role);

/** Tipos de activo que se controlan con llenar/vaciar/detener. */
export const isControllableType = (type: AssetDef['type'] | undefined): boolean => type === 'tank' || type === 'silo';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `metadata.control` saneado; `null` si el activo no lo tiene. */
export function controlConfigOf(def: Pick<AssetDef, 'metadata'> | undefined | null): ControlConfig | null {
  const c = isObj(def?.metadata) ? def.metadata.control : undefined;
  if (!isObj(c)) return null;
  const out: ControlConfig = { enabled: c.enabled === true };
  if (fin(c.minTarget)) out.minTarget = c.minTarget;
  if (fin(c.maxTarget)) out.maxTarget = c.maxTarget;
  if (fin(c.maxDurationMinutes)) out.maxDurationMinutes = c.maxDurationMinutes;
  return out;
}

/** El activo está habilitado para recibir órdenes (`metadata.control.enabled`). */
export const isControlEnabled = (def: Pick<AssetDef, 'metadata' | 'type'> | undefined | null): boolean =>
  !!def && isControllableType(def.type) && controlConfigOf(def)?.enabled === true;

/** Rango permitido del objetivo: `[minTarget, maxTarget]` del activo, con los valores por defecto del contrato. */
export function targetRange(def: Pick<AssetDef, 'metadata'> | undefined | null): { min: number; max: number } {
  const c = controlConfigOf(def);
  return { min: c?.minTarget ?? CONTROL_DEFAULTS.minTarget, max: c?.maxTarget ?? CONTROL_DEFAULTS.maxTarget };
}

/** Límite superior más bajo del nivel (el `HI` o, si no hay, el primero que encuentre la alarma): tope del objetivo menos el margen. */
export function highLevelLimit(limits: readonly Limit[]): Limit | undefined {
  let best: Limit | undefined;
  for (const l of limits) {
    if (l.metric !== 'level' || (l.operator !== 'gt' && l.operator !== 'gte')) continue;
    const isHi = l.kind === 'HI';
    const bestIsHi = best?.kind === 'HI';
    if (!best || (isHi && !bestIsHi) || (isHi === bestIsHi && l.threshold < best.threshold)) best = l;
  }
  return best;
}

/** Objetivo máximo efectivo: el menor entre `maxTarget` y (límite alto − margen de 2 puntos). */
export function maxAllowedTarget(def: Pick<AssetDef, 'metadata'> | undefined | null, limits: readonly Limit[]): number {
  const range = targetRange(def);
  const hi = highLevelLimit(limits);
  return hi ? Math.min(range.max, hi.threshold - HI_MARGIN) : range.max;
}

export interface InterlockContext {
  command: OrderCommand;
  target?: number;
  role: Role | null | undefined;
  /** el módulo `control` está activo para el cliente */
  moduleActive: boolean;
  def: Pick<AssetDef, 'metadata' | 'type'> | undefined;
  state: Pick<AssetState, 'ts' | 'values'> | undefined;
  now: number;
  limits: readonly Limit[];
  alarms: readonly Pick<AlarmEvent, 'asset' | 'metric' | 'kind' | 'severity' | 'state' | 'lifecycle' | 'acknowledged'>[];
  assetId: string;
  /** orden en curso del equipo, si la hay */
  activeOrder?: Pick<Order, 'command' | 'target' | 'status'> | null;
}

export interface InterlockResult {
  items: InterlockItem[];
  /** primer motivo por el que la orden no se puede dar; `null` si se puede */
  blocked: string | null;
}

const pct = (n: number) => `${String(Math.round(n * 10) / 10).replace('.', ',')} %`;

/** ¿Hay una alarma `HH` de nivel activa en el equipo? Sin `kind`, una crítica de límite alto del nivel cuenta como HH. */
export function hhActive(assetId: string, alarms: InterlockContext['alarms']): boolean {
  return alarms.some((a) => a.asset === assetId && a.metric === 'level' && isActiveCondition(a) && (a.kind ? a.kind === 'HH' : a.severity === 'critical'));
}

/**
 * Enclavamientos de una orden. Para `stop` solo cuentan el rol y que el equipo sea controlable (siempre se permite);
 * para `fill`/`drain` se evalúan todos, en este orden, y el primero que falla es el motivo principal.
 */
export function evaluateInterlocks(c: InterlockContext): InterlockResult {
  const items: InterlockItem[] = [];
  const add = (id: string, ok: boolean, label: string, reason?: string) => items.push(ok ? { id, label, ok } : { id, label, ok, reason });

  add('role', canOrder(c.role), 'Tu rol puede dar órdenes', 'Tu rol es de consulta: podés ver el estado y el registro, pero no dar órdenes.');
  if (c.command === 'stop') {
    const first = items.find((i) => !i.ok);
    return { items, blocked: first?.reason ?? null };
  }

  add('module', c.moduleActive, 'El módulo «Control de llenado» está contratado', 'El módulo «Control de llenado» no está contratado. Para sumarlo, contactá a Campos Ingeniería.');
  add('enabled', isControlEnabled(c.def), 'El equipo está habilitado para recibir órdenes', 'Este equipo no está habilitado para recibir órdenes. Un ingeniero o administrador tiene que habilitarlo en Administración.');

  const age = c.state ? c.now - c.state.ts : Infinity;
  add(
    'telemetry',
    age <= STALE_TELEMETRY_MS,
    'El equipo informa datos recientes (menos de 30 s)',
    c.state ? `El equipo no informa datos hace ${Math.round(age / 1000)} segundos (el máximo es 30). Revisá su conexión.` : 'Todavía no llegaron datos del equipo, así que no podemos darle órdenes.',
  );

  const level = c.state?.values.level;
  const range = targetRange(c.def);
  const maxT = maxAllowedTarget(c.def, c.limits);
  const t = c.target;
  if (t === undefined || !fin(t)) {
    add('target', false, 'El objetivo está dentro del rango permitido', 'Elegí el nivel objetivo.');
  } else {
    add('target', t >= range.min && t <= range.max, `El objetivo está entre ${pct(range.min)} y ${pct(range.max)}`, `El objetivo (${pct(t)}) tiene que estar entre ${pct(range.min)} y ${pct(range.max)}.`);
    const hi = highLevelLimit(c.limits);
    add(
      'headroom',
      t <= maxT + 1e-9,
      hi ? `El objetivo queda al menos ${HI_MARGIN} puntos por debajo del límite alto (${pct(hi.threshold)})` : 'El objetivo respeta el límite alto del nivel',
      hi ? `El objetivo (${pct(t)}) es demasiado alto: tiene que quedar por debajo de ${pct(maxT)} (límite alto ${pct(hi.threshold)} menos ${HI_MARGIN} puntos de margen).` : `El objetivo (${pct(t)}) supera el máximo permitido (${pct(maxT)}).`,
    );
    if (level !== undefined && fin(level)) {
      if (c.command === 'fill') add('direction', level < t, 'El nivel actual está por debajo del objetivo', `No hace falta llenar: el nivel actual (${pct(level)}) ya está en o por encima del objetivo (${pct(t)}).`);
      if (c.command === 'drain') add('direction', level > t, 'El nivel actual está por encima del objetivo', `No hace falta vaciar: el nivel actual (${pct(level)}) ya está en o por debajo del objetivo (${pct(t)}).`);
    }
  }
  if (c.command === 'fill') add('hh', !hhActive(c.assetId, c.alarms), 'No hay alarma de nivel muy alto (HH)', 'Hay una alarma de nivel muy alto (HH) activa: no se puede llenar hasta que se normalice.');

  const busy = c.activeOrder && isActiveOrder(c.activeOrder) ? c.activeOrder : null;
  add(
    'single',
    !busy,
    'No hay otra orden en curso',
    busy ? `Ya hay una orden en curso en este equipo (${COMMAND_LABEL_LOWER[busy.command] ?? busy.command}${busy.target !== undefined ? ` a ${pct(busy.target)}` : ''}). Esperá a que termine o detenela.` : undefined,
  );

  const first = items.find((i) => !i.ok);
  return { items, blocked: first?.reason ?? null };
}

const COMMAND_LABEL_LOWER: Record<string, string> = {
  fill: 'llenado', drain: 'vaciado', stop: 'detención', start: 'arranque', open: 'apertura', close: 'cierre', set_position: 'posición',
};

/** Resumen corto de los permisos: cuántos se cumplen. */
export function summarizeInterlocks(items: readonly InterlockItem[]): { ok: number; total: number; allOk: boolean } {
  const ok = items.filter((i) => i.ok).length;
  return { ok, total: items.length, allOk: ok === items.length };
}

/** El primer enclavamiento que falla (para mostrar «por qué no»). */
export const firstBlock = (items: readonly InterlockItem[]): InterlockItem | undefined => items.find((i) => !i.ok);
