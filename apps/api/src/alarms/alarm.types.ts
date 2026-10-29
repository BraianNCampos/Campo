import type { AlarmEvent, Severity } from '@campo/shared';

export type Operator = 'gt' | 'lt' | 'gte' | 'lte';
export const OPERATORS: readonly Operator[] = ['gt', 'lt', 'gte', 'lte'];
export const SEVERITIES: readonly Severity[] = ['warning', 'critical'];

export interface AlarmRule {
  id: string;
  plant: string;
  /** Id de activo exacto o patrón con `*` (p. ej. `tk-*`, `*`). */
  asset: string;
  metric: string;
  operator: Operator;
  threshold: number;
  severity: Severity;
  /** Debounce: la condición debe sostenerse este tiempo antes de activar. */
  forSeconds: number;
  /** Banda muerta para limpiar: gt/gte limpia en <= threshold - h; lt/lte en >= threshold + h. */
  hysteresis: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AlarmRuleInput = Omit<AlarmRule, 'id' | 'createdAt' | 'updatedAt'>;

/** Alarma persistida (REST): un AlarmEvent (ts = momento de activación) con ciclo de vida y ack. */
export interface AlarmRecord extends AlarmEvent {
  /** Momento en que se normalizó, epoch ms. */
  clearedAt?: number;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: number;
}

export const activeField = (e: Pick<AlarmEvent, 'asset' | 'metric' | 'ruleId'>): string =>
  `${e.asset}:${e.metric}:${e.ruleId}`;

/** Proyección de un registro persistido al contrato AlarmEvent (pub/sub y hash de activas). */
export const toEvent = (r: AlarmRecord): AlarmEvent => ({
  type: 'alarm',
  id: r.id,
  ruleId: r.ruleId,
  plant: r.plant,
  asset: r.asset,
  metric: r.metric,
  severity: r.severity,
  state: r.state,
  value: r.value,
  threshold: r.threshold,
  ts: r.ts,
  message: r.message,
  acknowledged: r.acknowledged,
});
