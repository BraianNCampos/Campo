import type { AlarmEvent, AlarmLifecycle, Severity } from '@campo/shared';

/**
 * Ciclo de vida de alarmas ISA-18.2 en el cliente (docs/architecture.md §12.2). Funciones puras, sin estado.
 *
 * `LiveAlarm` es el `AlarmEvent` tal como lo conserva el store: el último evento por `id` (upsert) más `clearedAt`
 * (instante en que volvió a normal; el contrato aún no lo define, se toma de `ts` del evento `cleared`).
 */
export type LiveAlarm = AlarmEvent & { clearedAt?: number };

/** Ciclos de vida que forman la lista de alarmas (lo que hay que atender). `shelved` y `closed` quedan fuera. */
export type ListedLifecycle = 'unacked' | 'acked' | 'rtn_unacked';

export const LISTED_LIFECYCLES: readonly ListedLifecycle[] = ['unacked', 'rtn_unacked', 'acked'];

export const LIFECYCLE_LABEL: Record<AlarmLifecycle, string> = {
  unacked: 'Sin reconocer',
  acked: 'Reconocida',
  rtn_unacked: 'Normalizada sin reconocer',
  shelved: 'Postergada',
  closed: 'Cerrada',
};

/**
 * Ciclo de vida efectivo. Los eventos anteriores al contrato (sin `lifecycle`) se derivan de `state` y `acknowledged`:
 * activa → sin reconocer / reconocida; normalizada → cerrada (como hasta ahora, sale de la lista).
 * Un `acknowledged: false` explícito gana sobre un `acked` local (la reversión de un ack optimista fallido).
 */
export function lifecycleOf(a: Pick<AlarmEvent, 'state' | 'lifecycle' | 'acknowledged'>): AlarmLifecycle {
  if (a.lifecycle) return a.lifecycle === 'acked' && a.acknowledged === false ? 'unacked' : a.lifecycle;
  if (a.state === 'cleared') return 'closed';
  return a.acknowledged ? 'acked' : 'unacked';
}

export const isListed = (a: Pick<AlarmEvent, 'state' | 'lifecycle' | 'acknowledged'>): boolean => {
  const l = lifecycleOf(a);
  return l === 'unacked' || l === 'acked' || l === 'rtn_unacked';
};

/** «Condición activa» para el aviso rojo en el equipo y el 3D: activa (sin reconocer o reconocida), no postergada. */
export const isActiveCondition = (a: Pick<AlarmEvent, 'state' | 'lifecycle' | 'acknowledged'>): boolean => {
  const l = lifecycleOf(a);
  return l === 'unacked' || l === 'acked';
};

export interface PriorityCount {
  critical: number;
  warning: number;
  total: number;
}

export interface AlarmCounts {
  /** lista de alarmas (sin reconocer + normalizadas sin reconocer + reconocidas) por prioridad */
  list: PriorityCount;
  unacked: PriorityCount;
  acked: PriorityCount;
  rtn_unacked: PriorityCount;
  shelved: PriorityCount;
}

const zero = (): PriorityCount => ({ critical: 0, warning: 0, total: 0 });

/** Conteo por ciclo de vida y prioridad (`severity`: critical = prioridad alta, warning = media). */
export function countAlarms(alarms: Iterable<LiveAlarm>): AlarmCounts {
  const c: AlarmCounts = { list: zero(), unacked: zero(), acked: zero(), rtn_unacked: zero(), shelved: zero() };
  const add = (p: PriorityCount, s: Severity) => {
    p[s]++;
    p.total++;
  };
  for (const a of alarms) {
    const l = lifecycleOf(a);
    if (l === 'closed') continue;
    add(c[l], a.severity);
    if (l !== 'shelved') add(c.list, a.severity);
  }
  return c;
}

const LIFECYCLE_ORDER: Record<AlarmLifecycle, number> = { unacked: 0, rtn_unacked: 1, acked: 2, shelved: 3, closed: 4 };

/** Orden de importancia: críticas primero, luego sin reconocer > normalizadas sin reconocer > reconocidas, recientes primero. */
export function rankAlarms<T extends LiveAlarm>(alarms: Iterable<T>): T[] {
  return [...alarms].sort(
    (a, b) =>
      (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0) ||
      LIFECYCLE_ORDER[lifecycleOf(a)] - LIFECYCLE_ORDER[lifecycleOf(b)] ||
      b.ts - a.ts ||
      a.id.localeCompare(b.id),
  );
}

/** Aviso por activo (tarjeta y 3D): el peor ciclo de vida y la mayor prioridad de sus alarmas en la lista. */
export interface AssetAlarmNotice {
  severity: Severity;
  /** `unacked`/`acked`: condición activa; `rtn_unacked`: ya volvió a normal pero falta reconocer */
  lifecycle: ListedLifecycle;
}

// Objetos internados: la identidad sólo cambia si cambia el aviso (los selectores finos no re-renderizan de más).
const NOTICES = {} as Record<string, AssetAlarmNotice>;
const notice = (severity: Severity, lifecycle: ListedLifecycle): AssetAlarmNotice =>
  (NOTICES[`${severity}:${lifecycle}`] ??= { severity, lifecycle });

/** Condición activa antes que normalizada; dentro de cada una, crítica antes que advertencia, sin reconocer antes que reconocida. */
export function noticeByAsset(alarms: Iterable<LiveAlarm>): Record<string, AssetAlarmNotice> {
  const score = (n: AssetAlarmNotice) =>
    (n.lifecycle === 'rtn_unacked' ? 0 : 4) + (n.severity === 'critical' ? 2 : 0) + (n.lifecycle === 'acked' ? 0 : 1);
  const out: Record<string, AssetAlarmNotice> = {};
  for (const a of alarms) {
    const l = lifecycleOf(a);
    if (l !== 'unacked' && l !== 'acked' && l !== 'rtn_unacked') continue;
    const n = notice(a.severity, l);
    const cur = out[a.asset];
    if (!cur || score(n) > score(cur)) out[a.asset] = n;
  }
  return out;
}
