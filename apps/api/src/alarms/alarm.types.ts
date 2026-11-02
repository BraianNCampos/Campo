import type {
  AlarmEvent,
  AlarmKind,
  AlarmLifecycle,
  AlarmRationale,
  Severity,
} from '@campo/shared';

export type Operator = 'gt' | 'lt' | 'gte' | 'lte';
export const OPERATORS: readonly Operator[] = ['gt', 'lt', 'gte', 'lte'];
export const SEVERITIES: readonly Severity[] = ['warning', 'critical'];
export const KINDS: readonly AlarmKind[] = ['HH', 'HI', 'LO', 'LL', 'DEV', 'ROC'];

export type RocDirection = 'any' | 'rise' | 'fall';
export const ROC_DIRECTIONS: readonly RocDirection[] = ['any', 'rise', 'fall'];

export type SuppressOperator = 'eq' | 'neq' | 'gt' | 'lt';
export const SUPPRESS_OPERATORS: readonly SuppressOperator[] = ['eq', 'neq', 'gt', 'lt'];

/** Supresión por estado (§12.1): mientras se cumpla sobre el último dato de `asset`, la alarma no se genera. */
export interface SuppressWhen {
  /** Id exacto o patrón con `*` (con patrón basta que UN activo coincidente cumpla la condición). */
  asset: string;
  metric: string;
  operator: SuppressOperator;
  value: number;
}

/** Límites de los parámetros ISA-18.2 de una regla. */
export const RULE_LIMITS = {
  rocWindowMin: 10,
  rocWindowMax: 600,
  rocWindowDefault: 60,
  offDelayMax: 86_400,
  descriptionMax: 200,
  consequenceMax: 300,
  responseMax: 300,
  reasonMin: 3,
  reasonMax: 300,
} as const;

export interface AlarmRule {
  id: string;
  plant: string;
  /** Id de activo exacto o patrón con `*` (p. ej. `tk-*`, `*`). */
  asset: string;
  metric: string;
  operator: Operator;
  /** HH/HI/LO/LL: valor límite. DEV: desviación máxima respecto del SP. ROC: tasa máxima por minuto. */
  threshold: number;
  severity: Severity;
  /** Debounce: la condición debe sostenerse este tiempo antes de activar. */
  forSeconds: number;
  /** Banda muerta para limpiar: gt/gte limpia en <= threshold - h; lt/lte en >= threshold + h. */
  hysteresis: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  // ---- ISA-18.2 (§12.1). Opcionales: ausentes = comportamiento anterior (ver `resolveRule`). ----
  kind?: AlarmKind;
  rocWindowSeconds?: number;
  rocDirection?: RocDirection;
  /** Retardo de retorno a normal. */
  offDelaySeconds?: number;
  suppressWhen?: SuppressWhen | null;
  description?: string | null;
  consequence?: string | null;
  response?: string | null;
  outOfServiceReason?: string | null;
}

export type AlarmRuleInput = Omit<AlarmRule, 'id' | 'createdAt' | 'updatedAt'>;

/** Regla con todos los campos ISA-18.2 resueltos (lo que ve la API y usa el evaluador). */
export type ResolvedRule = AlarmRule &
  Required<Pick<AlarmRule, 'kind' | 'rocWindowSeconds' | 'rocDirection' | 'offDelaySeconds'>> & {
    suppressWhen: SuppressWhen | null;
    description: string | null;
    consequence: string | null;
    response: string | null;
    outOfServiceReason: string | null;
  };

/** HH/HI con gt|gte -> crítica HH, advertencia HI; lt|lte -> crítica LL, advertencia LO. */
export function deriveKind(operator: Operator, severity: Severity): AlarmKind {
  const high = operator === 'gt' || operator === 'gte';
  if (high) return severity === 'critical' ? 'HH' : 'HI';
  return severity === 'critical' ? 'LL' : 'LO';
}

/** ¿Es un tipo de límite fijo (HH/HI/LO/LL)? DEV y ROC no lo son. */
export const isLimitKind = (k: AlarmKind): boolean => k !== 'DEV' && k !== 'ROC';

/** El operador debe ser coherente con el tipo (HH/HI/DEV/ROC: gt|gte; LO/LL: lt|lte). Devuelve el error o null. */
export function kindOperatorError(kind: AlarmKind, operator: Operator): string | null {
  const high = operator === 'gt' || operator === 'gte';
  if (kind === 'LO' || kind === 'LL') {
    return high ? `kind ${kind} exige operator lt o lte` : null;
  }
  return high
    ? null
    : `kind ${kind} exige operator gt o gte${kind === 'DEV' || kind === 'ROC' ? ' (compara una magnitud absoluta)' : ''}`;
}

export function resolveRule(r: AlarmRule): ResolvedRule {
  return {
    ...r,
    kind: r.kind ?? deriveKind(r.operator, r.severity),
    rocWindowSeconds: r.rocWindowSeconds ?? RULE_LIMITS.rocWindowDefault,
    rocDirection: r.rocDirection ?? 'any',
    offDelaySeconds: r.offDelaySeconds ?? 0,
    suppressWhen: r.suppressWhen ?? null,
    description: r.description ?? null,
    consequence: r.consequence ?? null,
    response: r.response ?? null,
    outOfServiceReason: r.outOfServiceReason ?? null,
  };
}

export function rationaleOf(
  r: Pick<AlarmRule, 'description' | 'consequence' | 'response'>,
): AlarmRationale | undefined {
  const out: AlarmRationale = {};
  if (r.description) out.description = r.description;
  if (r.consequence) out.consequence = r.consequence;
  if (r.response) out.response = r.response;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Alarma persistida (REST): un AlarmEvent (ts = momento de activación) con ciclo de vida y ack. */
export interface AlarmRecord extends AlarmEvent {
  /** Momento en que se normalizó, epoch ms. */
  clearedAt?: number;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: number;
  shelvedBy?: string;
}

export const activeField = (e: Pick<AlarmEvent, 'asset' | 'metric' | 'ruleId'>): string =>
  `${e.asset}:${e.metric}:${e.ruleId}`;

// ---- Ciclo de vida (§12.2): funciones puras, única definición de la tabla ----

/** Lifecycle efectivo de un registro/evento (los anteriores a ISA-18.2 no lo traen: se deriva). */
export function lifecycleOf(
  a: Pick<AlarmEvent, 'state' | 'lifecycle' | 'acknowledged'>,
): AlarmLifecycle {
  if (a.lifecycle) return a.lifecycle;
  if (a.state === 'active') return a.acknowledged ? 'acked' : 'unacked';
  return a.acknowledged ? 'closed' : 'rtn_unacked';
}

/** Al normalizarse: reconocida (o postergada) -> closed; sin reconocer -> rtn_unacked (sigue en la lista). */
export function clearedLifecycle(
  a: Pick<AlarmEvent, 'state' | 'lifecycle' | 'acknowledged'>,
): AlarmLifecycle {
  const lc = lifecycleOf(a);
  return lc === 'shelved' || a.acknowledged ? 'closed' : 'rtn_unacked';
}

/** Lifecycles que componen la lista de alarmas (`?state=active`). */
export const LIST_LIFECYCLES: readonly AlarmLifecycle[] = ['unacked', 'acked', 'rtn_unacked'];

export type AlarmListState = 'active' | 'cleared' | 'shelved';

/** `active` = lista (unacked, acked, rtn_unacked); `cleared` = closed; `shelved` = postergadas. */
export function matchesListState(lc: AlarmLifecycle, state: AlarmListState): boolean {
  if (state === 'active') return LIST_LIFECYCLES.includes(lc);
  return state === 'cleared' ? lc === 'closed' : lc === 'shelved';
}

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
  ...(r.kind ? { kind: r.kind } : {}),
  lifecycle: lifecycleOf(r),
  ...(r.rationale ? { rationale: r.rationale } : {}),
  ...(r.shelvedUntil ? { shelvedUntil: r.shelvedUntil } : {}),
  ...(r.shelvedReason ? { shelvedReason: r.shelvedReason } : {}),
});
