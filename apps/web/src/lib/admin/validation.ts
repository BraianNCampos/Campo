import { ID_PATTERN } from '@campo/shared';
import type { Role } from '@campo/shared';
import { ASSET_TYPES, OPERATORS, ROLES, SEVERITIES } from './types';
import type { AlarmRuleInput, AssetInput, AssetType, Operator, Severity } from './types';

export type FieldErrors = Record<string, string>;

export const PASSWORD_MIN = 12;
const PASSWORD_MAX_BYTES = 72;
export const RULE_ASSET_PATTERN = /^[a-z0-9*][a-z0-9_*-]{0,63}$/;
export const RULE_METRIC_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const hasErrors = (e: FieldErrors) => Object.keys(e).length > 0;

const byteLength = (s: string) => new TextEncoder().encode(s).length;

export function validatePassword(pw: string, field = 'password'): FieldErrors {
  if (pw.length < PASSWORD_MIN) return { [field]: `Mínimo ${PASSWORD_MIN} caracteres (llevas ${pw.length}).` };
  if (byteLength(pw) > PASSWORD_MAX_BYTES) return { [field]: `No puede superar ${PASSWORD_MAX_BYTES} bytes.` };
  return {};
}

/** Progreso hacia la longitud mínima (0..1) y texto para el indicador. */
export function passwordStrength(pw: string): { ratio: number; ok: boolean; text: string } {
  const ok = pw.length >= PASSWORD_MIN;
  return {
    ratio: Math.min(1, pw.length / PASSWORD_MIN),
    ok,
    text: ok ? `Longitud suficiente (${pw.length} caracteres)` : `${pw.length} de ${PASSWORD_MIN} caracteres mínimos`,
  };
}

export function validatePlantId(id: string): string | null {
  if (!id) return 'El id es obligatorio.';
  if (!ID_PATTERN.test(id)) return 'Usa minúsculas, números, "-" o "_" (máx. 64), empezando por letra o número.';
  return null;
}

export function validatePlantForm(v: { id: string; name: string }, opts: { editing?: boolean } = {}): FieldErrors {
  const e: FieldErrors = {};
  if (!opts.editing) {
    const idErr = validatePlantId(v.id.trim());
    if (idErr) e.id = idErr;
  }
  const name = v.name.trim();
  if (!name) e.name = 'El nombre es obligatorio.';
  else if (name.length > 120) e.name = 'Máximo 120 caracteres.';
  return e;
}

export interface UserForm {
  email: string;
  password: string;
  role: Role | '';
  plants: string[];
}

export function validateUserForm(v: UserForm): { errors: FieldErrors; value?: { email: string; password: string; role: Role; plants: string[] } } {
  const errors: FieldErrors = {};
  const email = v.email.trim().toLowerCase();
  if (!email) errors.email = 'El correo es obligatorio.';
  else if (!EMAIL.test(email) || email.length > 254) errors.email = 'Introduce un correo válido (nombre@dominio.com).';
  Object.assign(errors, validatePassword(v.password));
  if (!ROLES.includes(v.role as Role)) errors.role = 'Elige un rol.';
  if (v.plants.some((p) => !ID_PATTERN.test(p))) errors.plants = 'Alguna planta no es válida.';
  if (hasErrors(errors)) return { errors };
  return { errors, value: { email, password: v.password, role: v.role as Role, plants: [...new Set(v.plants)] } };
}

export function validatePasswordChange(v: { current: string; next: string; confirm: string }): FieldErrors {
  const e: FieldErrors = {};
  if (!v.current) e.current = 'Introduce tu contraseña actual.';
  Object.assign(e, validatePassword(v.next, 'next'));
  if (!e.next && v.next === v.current) e.next = 'La nueva contraseña debe ser distinta de la actual.';
  if (!v.confirm) e.confirm = 'Repite la nueva contraseña.';
  else if (v.confirm !== v.next) e.confirm = 'No coincide con la nueva contraseña.';
  return e;
}

// ── Activos ──

/** Traduce la posición del error de JSON.parse a línea/columna legibles. */
export function parseMetadata(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const src = text.trim();
  if (!src) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(src);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    const pos = /position (\d+)/.exec(msg);
    if (pos) {
      const before = src.slice(0, Number(pos[1]));
      const line = before.split('\n').length;
      const col = before.length - before.lastIndexOf('\n');
      return { ok: false, error: `JSON no válido (línea ${line}, columna ${col}). Revisa comas, comillas dobles y llaves.` };
    }
    return { ok: false, error: 'JSON no válido. Revisa comas, comillas dobles y llaves.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Los metadatos deben ser un objeto JSON, p. ej. {"capacityL": 5000}.' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export interface AssetForm {
  id: string;
  name: string;
  type: AssetType | '';
  model3dRef: string;
  metadataText: string;
}

export function validateAssetForm(v: AssetForm, opts: { editing?: boolean } = {}): { errors: FieldErrors; value?: AssetInput } {
  const errors: FieldErrors = {};
  const id = v.id.trim();
  if (!opts.editing) {
    const idErr = validatePlantId(id);
    if (idErr) errors.id = idErr;
  }
  const name = v.name.trim();
  if (!name) errors.name = 'El nombre es obligatorio.';
  else if (name.length > 120) errors.name = 'Máximo 120 caracteres.';
  if (!ASSET_TYPES.includes(v.type as AssetType)) errors.type = 'Elige un tipo.';
  const ref = v.model3dRef.trim();
  if (ref.length > 200) errors.model3dRef = 'Máximo 200 caracteres.';
  const meta = parseMetadata(v.metadataText);
  if (!meta.ok) errors.metadata = meta.error;
  if (hasErrors(errors) || !meta.ok) return { errors };
  return { errors, value: { id, name, type: v.type as AssetType, model3dRef: ref || null, metadata: meta.value } };
}

// ── Reglas de alarma ──

export interface RuleForm {
  plant: string;
  asset: string;
  metric: string;
  operator: Operator | '';
  threshold: string;
  severity: Severity | '';
  forSeconds: string;
  hysteresis: string;
  enabled: boolean;
}

export const emptyRuleForm = (plant = ''): RuleForm => ({
  plant,
  asset: '',
  metric: '',
  operator: 'gt',
  threshold: '',
  severity: 'warning',
  forSeconds: '0',
  hysteresis: '0',
  enabled: true,
});

const num = (s: string): number => (s.trim() === '' ? NaN : Number(s));

/** Misma política que `CreateRuleDto` del servidor (apps/api/src/alarms/dto.ts). */
export function validateRuleForm(v: RuleForm): { errors: FieldErrors; value?: AlarmRuleInput } {
  const errors: FieldErrors = {};
  if (!v.plant) errors.plant = 'Elige una planta.';
  else if (!ID_PATTERN.test(v.plant)) errors.plant = 'Planta no válida.';
  const asset = v.asset.trim();
  if (!asset) errors.asset = 'Indica un activo o un patrón con * (p. ej. tk-*).';
  else if (!RULE_ASSET_PATTERN.test(asset)) errors.asset = 'Id exacto o patrón con * en minúsculas (p. ej. tk-*, *).';
  const metric = v.metric.trim();
  if (!metric) errors.metric = 'Indica la métrica (p. ej. level).';
  else if (!RULE_METRIC_PATTERN.test(metric)) errors.metric = 'Sólo letras, números, "_", "." o "-" (máx. 64).';
  if (!OPERATORS.includes(v.operator as Operator)) errors.operator = 'Elige un operador.';
  const threshold = num(v.threshold);
  if (!Number.isFinite(threshold)) errors.threshold = 'El umbral debe ser un número.';
  if (!SEVERITIES.includes(v.severity as Severity)) errors.severity = 'Elige una severidad.';
  const forSeconds = num(v.forSeconds);
  if (!Number.isInteger(forSeconds) || forSeconds < 0 || forSeconds > 86_400) {
    errors.forSeconds = 'Entero entre 0 y 86 400 segundos.';
  }
  const hysteresis = num(v.hysteresis);
  if (!Number.isFinite(hysteresis) || hysteresis < 0) errors.hysteresis = 'Número igual o mayor que 0.';
  if (hasErrors(errors)) return { errors };
  return {
    errors,
    value: {
      plant: v.plant,
      asset,
      metric,
      operator: v.operator as Operator,
      threshold,
      severity: v.severity as Severity,
      forSeconds,
      hysteresis,
      enabled: v.enabled,
    },
  };
}

export const OPERATOR_LABEL: Record<Operator, string> = {
  gt: '> mayor que',
  lt: '< menor que',
  gte: '≥ mayor o igual que',
  lte: '≤ menor o igual que',
};
export const OPERATOR_SYMBOL: Record<Operator, string> = { gt: '>', lt: '<', gte: '≥', lte: '≤' };

/** Frase de vista previa: cuándo se activa y cuándo se normaliza. */
export function describeRule(r: Pick<AlarmRuleInput, 'metric' | 'operator' | 'threshold' | 'forSeconds' | 'hysteresis'>): string {
  const up = r.operator === 'gt' || r.operator === 'gte';
  const clearAt = up ? r.threshold - r.hysteresis : r.threshold + r.hysteresis;
  const hold = r.forSeconds > 0 ? ` durante ${r.forSeconds} s` : '';
  const clear = r.hysteresis > 0 ? `se normaliza al ${up ? 'bajar' : 'subir'} a ${round(clearAt)}` : `se normaliza al dejar de cumplirse`;
  return `Se activa cuando ${r.metric} ${OPERATOR_SYMBOL[r.operator]} ${r.threshold}${hold}; ${clear}.`;
}
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** ¿El patrón de una regla (`tk-*`) nombra/abarca este activo? Sólo `*` es comodín. */
export function ruleMatchesAsset(pattern: string, assetId: string): boolean {
  if (!pattern.includes('*')) return pattern === assetId;
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(assetId);
}
