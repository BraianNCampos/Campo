import type { AlarmEvent } from '@campo/shared';

export const FOOTER_TOP = 3;

export interface AlarmSummary {
  critical: number;
  warning: number;
  total: number;
  /** activas sin reconocer */
  unacked: number;
  /** las más importantes: críticas primero, sin reconocer primero, más recientes primero */
  top: AlarmEvent[];
}

/** Orden de importancia de las alarmas activas (misma regla que la lista completa). */
export function rankAlarms(alarms: Iterable<AlarmEvent>): AlarmEvent[] {
  return [...alarms].sort(
    (a, b) =>
      (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0) ||
      Number(!!a.acknowledged) - Number(!!b.acknowledged) ||
      b.ts - a.ts ||
      a.id.localeCompare(b.id),
  );
}

/** Resumen para el pie global: conteo por prioridad y las 3 más importantes. */
export function summarizeAlarms(alarms: Record<string, AlarmEvent>, top = FOOTER_TOP): AlarmSummary {
  const list = Object.values(alarms).filter((a) => a.state === 'active');
  return {
    critical: list.filter((a) => a.severity === 'critical').length,
    warning: list.filter((a) => a.severity === 'warning').length,
    total: list.length,
    unacked: list.filter((a) => !a.acknowledged).length,
    top: rankAlarms(list).slice(0, top),
  };
}
