import { ID_PATTERN, METRICS } from '@campo/shared';
import type { AssetDef } from '@campo/shared';
import { RULE_ASSET_PATTERN, RULE_METRIC_PATTERN, ruleMatchesAsset, type FieldErrors } from './validation';
import { OPERATORS, ROC_DIRECTIONS, SEVERITIES, SUPPRESS_OPERATORS } from './types';
import type { AlarmKind, AlarmRule, AlarmRuleInput, Operator, RocDirection, Severity, SuppressOperator } from './types';

/** Editor de reglas ISA-18.2: formulario, validación alineada con la API (docs §12.1) y vista previa en lenguaje natural. */

export const RULE_KINDS: readonly AlarmKind[] = ['HH', 'HI', 'LO', 'LL', 'DEV', 'ROC'];

export const KIND_NAME: Record<AlarmKind, string> = {
  HH: 'Muy alto',
  HI: 'Alto',
  LO: 'Bajo',
  LL: 'Muy bajo',
  DEV: 'Desviación',
  ROC: 'Cambio brusco',
};

export const KIND_HELP: Record<AlarmKind, string> = {
  HH: 'Avisa cuando el valor sube por encima de un límite muy alto. Suele ser crítica.',
  HI: 'Avisa cuando el valor sube por encima de un límite alto: una advertencia a tiempo.',
  LO: 'Avisa cuando el valor baja de un límite bajo: una advertencia a tiempo.',
  LL: 'Avisa cuando el valor baja de un límite muy bajo. Suele ser crítica.',
  DEV: 'Avisa cuando el valor se aleja del setpoint (el valor deseado) más de lo tolerado, para arriba o para abajo.',
  ROC: 'Avisa cuando el valor cambia demasiado rápido (por minuto), aunque todavía no llegue a un límite.',
};

/** Tipo por defecto según operador y severidad (igual que la API cuando la regla no trae `kind`). */
export function deriveKind(operator: Operator, severity: Severity): AlarmKind {
  const up = operator === 'gt' || operator === 'gte';
  return up ? (severity === 'critical' ? 'HH' : 'HI') : severity === 'critical' ? 'LL' : 'LO';
}

export const kindOf = (r: Pick<AlarmRule, 'kind' | 'operator' | 'severity'>): AlarmKind => r.kind ?? deriveKind(r.operator, r.severity);

/** Operadores que admite cada tipo: HH/HI hacia arriba, LO/LL hacia abajo; DEV y ROC comparan una magnitud (siempre «mayor que»). */
export function operatorsFor(kind: AlarmKind): Operator[] {
  return kind === 'HH' || kind === 'HI' ? ['gt', 'gte'] : kind === 'LO' || kind === 'LL' ? ['lt', 'lte'] : ['gt'];
}

export const OPERATOR_LABEL: Record<Operator, string> = {
  gt: '> mayor que',
  lt: '< menor que',
  gte: '≥ mayor o igual que',
  lte: '≤ menor o igual que',
};
export const OPERATOR_SYMBOL: Record<Operator, string> = { gt: '>', lt: '<', gte: '≥', lte: '≤' };
export const SUPPRESS_LABEL: Record<SuppressOperator, string> = { eq: 'es igual a', neq: 'es distinto de', gt: 'es mayor que', lt: 'es menor que' };
export const ROC_LABEL: Record<RocDirection, string> = { any: 'Sube o baja', rise: 'Solo sube', fall: 'Solo baja' };

/** Prioridad sugerida al elegir un tipo (se puede cambiar después). */
export const suggestedSeverity = (kind: AlarmKind): Severity => (kind === 'HH' || kind === 'LL' ? 'critical' : 'warning');

export interface SuppressForm {
  asset: string;
  metric: string;
  operator: SuppressOperator;
  value: string;
}

export interface RuleForm {
  plant: string;
  asset: string;
  metric: string;
  kind: AlarmKind;
  operator: Operator | '';
  threshold: string;
  severity: Severity | '';
  forSeconds: string;
  offDelaySeconds: string;
  hysteresis: string;
  rocWindowSeconds: string;
  rocDirection: RocDirection;
  suppressEnabled: boolean;
  suppress: SuppressForm;
  description: string;
  consequence: string;
  response: string;
  enabled: boolean;
  outOfServiceReason: string;
}

export const emptyRuleForm = (plant = ''): RuleForm => ({
  plant,
  asset: '',
  metric: '',
  kind: 'HI',
  operator: 'gt',
  threshold: '',
  severity: 'warning',
  forSeconds: '0',
  offDelaySeconds: '0',
  hysteresis: '0',
  rocWindowSeconds: '60',
  rocDirection: 'any',
  suppressEnabled: false,
  suppress: { asset: '', metric: '', operator: 'lt', value: '' },
  description: '',
  consequence: '',
  response: '',
  enabled: true,
  outOfServiceReason: '',
});

export function ruleToForm(r: AlarmRule): RuleForm {
  const s = r.suppressWhen;
  return {
    plant: r.plant,
    asset: r.asset,
    metric: r.metric,
    kind: kindOf(r),
    operator: r.operator,
    threshold: String(r.threshold),
    severity: r.severity,
    forSeconds: String(r.forSeconds),
    offDelaySeconds: String(r.offDelaySeconds ?? 0),
    hysteresis: String(r.hysteresis),
    rocWindowSeconds: String(r.rocWindowSeconds ?? 60),
    rocDirection: r.rocDirection ?? 'any',
    suppressEnabled: !!s,
    suppress: s ? { asset: s.asset, metric: s.metric, operator: s.operator, value: String(s.value) } : { asset: '', metric: '', operator: 'lt', value: '' },
    description: r.description ?? '',
    consequence: r.consequence ?? '',
    response: r.response ?? '',
    enabled: r.enabled,
    outOfServiceReason: r.outOfServiceReason ?? '',
  };
}

/** Cambia el tipo y ajusta lo que depende de él: operador válido y prioridad sugerida. */
export function withKind(f: RuleForm, kind: AlarmKind): RuleForm {
  const ops = operatorsFor(kind);
  return { ...f, kind, operator: ops.includes(f.operator as Operator) ? f.operator : ops[0]!, severity: suggestedSeverity(kind) };
}

export const LIMITS = { description: 200, consequence: 300, response: 300, reason: 300, rocMin: 10, rocMax: 600, delayMax: 86_400, reasonMin: 3 } as const;

const num = (s: string): number => (s.trim() === '' ? NaN : Number(s));
const hasErrors = (e: FieldErrors) => Object.keys(e).length > 0;

/**
 * Misma política que `CreateRuleDto` del servidor (apps/api/src/alarms/dto.ts) con los campos de §12.1.
 * `editing`: al editar se envían `null` para vaciar lo opcional (supresión, textos); al crear se omiten.
 */
export function validateRuleForm(v: RuleForm, opts: { editing?: boolean } = {}): { errors: FieldErrors; value?: AlarmRuleInput } {
  const errors: FieldErrors = {};
  if (!v.plant) errors.plant = 'Elegí una planta.';
  else if (!ID_PATTERN.test(v.plant)) errors.plant = 'Planta no válida.';
  const asset = v.asset.trim();
  if (!asset) errors.asset = 'Indicá un activo o un patrón con * (p. ej. tk-*).';
  else if (!RULE_ASSET_PATTERN.test(asset)) errors.asset = 'Id exacto o patrón con * en minúsculas (p. ej. tk-*, *).';
  const metric = v.metric.trim();
  if (!metric) errors.metric = 'Indicá la métrica (p. ej. level).';
  else if (!RULE_METRIC_PATTERN.test(metric)) errors.metric = 'Sólo letras, números, "_", "." o "-" (máx. 64).';
  if (!RULE_KINDS.includes(v.kind)) errors.kind = 'Elegí un tipo de alarma.';
  const operator: Operator | '' = v.kind === 'DEV' || v.kind === 'ROC' ? 'gt' : v.operator;
  if (!OPERATORS.includes(operator as Operator) || !operatorsFor(v.kind).includes(operator as Operator)) errors.operator = 'Elegí un operador.';
  const threshold = num(v.threshold);
  if (!Number.isFinite(threshold)) errors.threshold = v.kind === 'DEV' ? 'Indicá cuánto se puede desviar (un número).' : v.kind === 'ROC' ? 'Indicá el cambio máximo por minuto (un número).' : 'El umbral debe ser un número.';
  else if ((v.kind === 'DEV' || v.kind === 'ROC') && threshold <= 0) errors.threshold = 'Tiene que ser mayor que 0.';
  if (!SEVERITIES.includes(v.severity as Severity)) errors.severity = 'Elegí una severidad.';
  const forSeconds = num(v.forSeconds);
  if (!Number.isInteger(forSeconds) || forSeconds < 0 || forSeconds > LIMITS.delayMax) errors.forSeconds = 'Entero entre 0 y 86 400 segundos.';
  const offDelay = num(v.offDelaySeconds);
  if (!Number.isInteger(offDelay) || offDelay < 0 || offDelay > LIMITS.delayMax) errors.offDelaySeconds = 'Entero entre 0 y 86 400 segundos.';
  const hysteresis = num(v.hysteresis);
  if (!Number.isFinite(hysteresis) || hysteresis < 0) errors.hysteresis = 'Número igual o mayor que 0.';
  let rocWindow: number | undefined;
  if (v.kind === 'ROC') {
    rocWindow = num(v.rocWindowSeconds);
    if (!Number.isInteger(rocWindow) || rocWindow < LIMITS.rocMin || rocWindow > LIMITS.rocMax) errors.rocWindowSeconds = `Entero entre ${LIMITS.rocMin} y ${LIMITS.rocMax} segundos.`;
    if (!ROC_DIRECTIONS.includes(v.rocDirection)) errors.rocDirection = 'Elegí una dirección.';
  }

  let suppressWhen: AlarmRuleInput['suppressWhen'] = opts.editing ? null : undefined;
  if (v.suppressEnabled) {
    const s = v.suppress;
    const sAsset = s.asset.trim();
    const sMetric = s.metric.trim();
    const sValue = num(s.value);
    if (!sAsset) errors['suppress.asset'] = 'Indicá el activo que se observa (p. ej. pump-01).';
    else if (!ID_PATTERN.test(sAsset)) errors['suppress.asset'] = 'Id exacto de un activo, sin *.';
    if (!sMetric) errors['suppress.metric'] = 'Indicá la medida que se observa (p. ej. rpm).';
    else if (!RULE_METRIC_PATTERN.test(sMetric)) errors['suppress.metric'] = 'Sólo letras, números, "_", "." o "-" (máx. 64).';
    if (!SUPPRESS_OPERATORS.includes(s.operator)) errors['suppress.operator'] = 'Elegí una condición.';
    if (!Number.isFinite(sValue)) errors['suppress.value'] = 'El valor debe ser un número.';
    if (!errors['suppress.asset'] && !errors['suppress.metric'] && !errors['suppress.operator'] && !errors['suppress.value']) {
      suppressWhen = { asset: sAsset, metric: sMetric, operator: s.operator, value: sValue };
    }
  }

  const text = (k: 'description' | 'consequence' | 'response'): string | null | undefined => {
    const t = v[k].trim();
    if (t.length > LIMITS[k]) errors[k] = `Máximo ${LIMITS[k]} caracteres (llevás ${t.length}).`;
    return t || (opts.editing ? null : undefined);
  };
  const description = text('description');
  const consequence = text('consequence');
  const response = text('response');

  const reason = v.outOfServiceReason.trim();
  if (!v.enabled) {
    if (reason.length < LIMITS.reasonMin) errors.outOfServiceReason = `Para sacarla de servicio contanos el motivo (mínimo ${LIMITS.reasonMin} caracteres).`;
    else if (reason.length > LIMITS.reason) errors.outOfServiceReason = `Máximo ${LIMITS.reason} caracteres.`;
  }
  if (hasErrors(errors)) return { errors };

  const value: AlarmRuleInput = {
    plant: v.plant,
    asset,
    metric,
    operator: operator as Operator,
    threshold,
    severity: v.severity as Severity,
    forSeconds,
    hysteresis,
    enabled: v.enabled,
    kind: v.kind,
    offDelaySeconds: offDelay,
  };
  if (v.kind === 'ROC') {
    value.rocWindowSeconds = rocWindow;
    value.rocDirection = v.rocDirection;
  }
  if (suppressWhen !== undefined) value.suppressWhen = suppressWhen;
  if (description !== undefined) value.description = description;
  if (consequence !== undefined) value.consequence = consequence;
  if (response !== undefined) value.response = response;
  if (!v.enabled) value.outOfServiceReason = reason;
  else if (opts.editing) value.outOfServiceReason = null;
  return { errors, value };
}

// ── Vista previa en lenguaje natural ──

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6).replace('.', ',');

/** «90 %», «35 °C», «8 bar»; sin unidad, el número solo. */
export function withUnit(metric: string, n: number): string {
  const u = METRICS[metric]?.unit;
  return u ? `${fmt(n)} ${u}` : fmt(n);
}

const FEMININE = new Set(['temp', 'humidity', 'rpm', 'current', 'position', 'kw', 'kwh', 'pressure']);
/** «el nivel», «la temperatura»; una medida desconocida se nombra por su id. */
const noun = (metric: string) => {
  const label = METRICS[metric]?.label;
  return label ? `${FEMININE.has(metric) ? 'la' : 'el'} ${lower(label)}` : `la medida «${metric}»`;
};

/** Cómo se nombra el activo: el del catálogo si es exacto; un patrón se dice como tal. */
export function assetPhrase(pattern: string, assets: readonly Pick<AssetDef, 'id' | 'name'>[]): string {
  const p = pattern.trim();
  if (!p) return 'el activo';
  if (!p.includes('*')) return assets.find((a) => a.id === p)?.name ?? p;
  if (p === '*') return 'cualquier activo';
  return `cualquiera de los activos «${p}»`;
}

export interface PreviewInput {
  asset: string;
  metric: string;
  kind: AlarmKind;
  operator: Operator;
  threshold: number;
  forSeconds: number;
  offDelaySeconds: number;
  hysteresis: number;
  rocWindowSeconds?: number;
  rocDirection?: RocDirection;
  suppressWhen?: { asset: string; metric: string; operator: SuppressOperator; value: number } | null;
  enabled: boolean;
  outOfServiceReason?: string | null;
}

/**
 * Explica la regla con palabras: cuándo avisa, cuándo vuelve a normal, cuándo no avisa y si está fuera de servicio.
 * Ej.: «Avisa cuando el nivel de Tanque 01 supere 90 % durante 5 s y vuelve a normal por debajo de 88 %.»
 */
export function previewRule(r: PreviewInput, assets: readonly Pick<AssetDef, 'id' | 'name'>[] = []): string[] {
  const who = assetPhrase(r.asset, assets);
  const what = `${noun(r.metric)} de ${who}`;
  const hold = r.forSeconds > 0 ? ` durante ${r.forSeconds} s` : '';
  const back = r.offDelaySeconds > 0 ? ` y se sostiene ${r.offDelaySeconds} s` : '';
  let line: string;
  if (r.kind === 'DEV') {
    const clearAt = Math.max(0, r.threshold - r.hysteresis);
    const norm = r.hysteresis > 0 ? `cuando la desviación baja de ${withUnit(r.metric, clearAt)}` : 'cuando la desviación vuelve a quedar dentro de lo tolerado';
    line = `Avisa cuando ${what} se desvíe más de ${withUnit(r.metric, r.threshold)} de su setpoint${hold} y vuelve a normal ${norm}${back}.`;
  } else if (r.kind === 'ROC') {
    const verb = r.rocDirection === 'rise' ? 'suba' : r.rocDirection === 'fall' ? 'baje' : 'cambie';
    const win = r.rocWindowSeconds ? ` (medido en ${r.rocWindowSeconds} s)` : '';
    line = `Avisa cuando ${what} ${verb} más de ${withUnit(r.metric, r.threshold)} por minuto${win}${hold} y vuelve a normal cuando deja de cambiar tan rápido${back}.`;
  } else {
    const up = r.operator === 'gt' || r.operator === 'gte';
    const verb = r.operator === 'gt' ? 'supere' : r.operator === 'gte' ? 'alcance o supere' : r.operator === 'lt' ? 'baje de' : 'llegue a';
    const tail = r.operator === 'lte' ? ' o menos' : '';
    const clearAt = up ? r.threshold - r.hysteresis : r.threshold + r.hysteresis;
    const norm =
      r.hysteresis > 0
        ? `vuelve a normal ${up ? 'por debajo de' : 'por encima de'} ${withUnit(r.metric, clearAt)}`
        : 'vuelve a normal apenas deja de cumplirse';
    line = `Avisa cuando ${what} ${verb} ${withUnit(r.metric, r.threshold)}${tail}${hold} y ${norm}${back}.`;
  }
  const out = [line];
  if (r.suppressWhen) {
    const s = r.suppressWhen;
    out.push(`No avisa mientras ${noun(s.metric)} de ${assetPhrase(s.asset, assets)} ${SUPPRESS_LABEL[s.operator]} ${withUnit(s.metric, s.value)}: en ese caso la alarma se suprime y se cuenta como suprimida.`);
  }
  if (!r.enabled) out.push(`Fuera de servicio: no avisa.${r.outOfServiceReason ? ` Motivo: ${r.outOfServiceReason.trim()}.` : ''}`);
  return out;
}

/** Vista previa desde el formulario (sin validar del todo): `null` si todavía no hay lo mínimo para explicarla. */
export function previewFromForm(f: RuleForm, assets: readonly Pick<AssetDef, 'id' | 'name'>[] = []): string[] | null {
  const t = num(f.threshold);
  if (!f.metric.trim() || !Number.isFinite(t)) return null;
  const n = (s: string) => (Number.isFinite(num(s)) ? num(s) : 0);
  const sv = num(f.suppress.value);
  const sup = f.suppressEnabled && f.suppress.asset.trim() && f.suppress.metric.trim() && Number.isFinite(sv);
  return previewRule(
    {
      asset: f.asset,
      metric: f.metric.trim(),
      kind: f.kind,
      operator: f.kind === 'DEV' || f.kind === 'ROC' ? 'gt' : ((f.operator || 'gt') as Operator),
      threshold: t,
      forSeconds: n(f.forSeconds),
      offDelaySeconds: n(f.offDelaySeconds),
      hysteresis: n(f.hysteresis),
      rocWindowSeconds: f.kind === 'ROC' ? n(f.rocWindowSeconds) : undefined,
      rocDirection: f.rocDirection,
      suppressWhen: sup ? { asset: f.suppress.asset.trim(), metric: f.suppress.metric.trim(), operator: f.suppress.operator, value: sv } : null,
      enabled: f.enabled,
      outOfServiceReason: f.outOfServiceReason,
    },
    assets,
  );
}

// ── Setpoints (DEV) ──

export type SetpointStatus = 'ok' | 'partial' | 'missing' | 'unknown';

/** ¿Tienen setpoint los activos que abarca la regla? Sin él, una DEV no se evalúa (docs §12.1, §12.4). */
export function setpointStatus(pattern: string, metric: string, assets: readonly Pick<AssetDef, 'id' | 'metadata'>[]): SetpointStatus {
  const m = metric.trim();
  const matched = assets.filter((a) => ruleMatchesAsset(pattern.trim(), a.id));
  if (!m || matched.length === 0) return 'unknown';
  const has = (a: Pick<AssetDef, 'metadata'>) => {
    const sp = (a.metadata as { setpoints?: Record<string, unknown> } | undefined)?.setpoints?.[m];
    return typeof sp === 'number' && Number.isFinite(sp);
  };
  const n = matched.filter(has).length;
  return n === matched.length ? 'ok' : n === 0 ? 'missing' : 'partial';
}

export function setpointMessage(status: SetpointStatus, metric: string): string | null {
  const m = noun(metric.trim()).replace(/^(el|la) /, '');
  if (status === 'missing') return `Ninguno de los activos tiene setpoint de ${m}: la regla no se evalúa hasta que lo tenga. Cargalo en el activo («setpoints») o que el controlador informe «${metric.trim()}_sp».`;
  if (status === 'partial') return `Algunos de los activos no tienen setpoint de ${m}: en esos la regla no se evalúa.`;
  return null;
}

/** Texto corto de la condición de una regla para tablas y etiquetas (`level > 90`, `desvío temp > 6`, `cambio pressure > 2/min`). */
export function conditionText(r: Pick<AlarmRule, 'kind' | 'operator' | 'severity' | 'metric' | 'threshold'>): string {
  const k = kindOf(r);
  if (k === 'DEV') return `desvío ${r.metric} > ${r.threshold}`;
  if (k === 'ROC') return `cambio ${r.metric} > ${r.threshold}/min`;
  return `${r.metric} ${OPERATOR_SYMBOL[r.operator]} ${r.threshold}`;
}
