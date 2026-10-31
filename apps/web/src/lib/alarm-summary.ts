import { countAlarms, isListed, rankAlarms, type AlarmCounts, type LiveAlarm } from './alarm-lifecycle';

export const FOOTER_TOP = 3;

export { rankAlarms };

export interface AlarmSummary {
  counts: AlarmCounts;
  /** lista activa (sin reconocer + normalizadas sin reconocer + reconocidas) */
  total: number;
  critical: number;
  warning: number;
  unacked: number;
  rtnUnacked: number;
  shelved: number;
  /** las más importantes de la lista activa */
  top: LiveAlarm[];
}

/** Resumen para el pie global: conteo por ciclo de vida y prioridad, y las 3 más importantes. */
export function summarizeAlarms(alarms: Record<string, LiveAlarm>, top = FOOTER_TOP): AlarmSummary {
  const all = Object.values(alarms);
  const counts = countAlarms(all);
  return {
    counts,
    total: counts.list.total,
    critical: counts.list.critical,
    warning: counts.list.warning,
    unacked: counts.unacked.total,
    rtnUnacked: counts.rtn_unacked.total,
    shelved: counts.shelved.total,
    top: rankAlarms(all.filter(isListed)).slice(0, top),
  };
}
