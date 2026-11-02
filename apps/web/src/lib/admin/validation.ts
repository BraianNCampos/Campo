import { ASSET_KINDS, ID_PATTERN, METRICS, MODEL_REF_PATTERN, MODULE_IDS, moduleForAssetType } from '@campo/shared';
import type { AssetDef, AssetLayout, ControlConfig, ModuleId, Role } from '@campo/shared';
import { LAYOUT_LIMITS, parseConnectsTo, parseLayout } from '@/lib/catalog';
import { validateTag } from '@/lib/tags';
import { MODULE_DISABLED_TEXT } from './errors';
import { ASSET_TYPES, ROLES } from './types';
import type { AssetInput, AssetType } from './types';

export type FieldErrors = Record<string, string>;

export const PASSWORD_MIN = 12;
const PASSWORD_MAX_BYTES = 72;
export const RULE_ASSET_PATTERN = /^[a-z0-9*][a-z0-9_*-]{0,63}$/;
export const RULE_METRIC_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const hasErrors = (e: FieldErrors) => Object.keys(e).length > 0;

const byteLength = (s: string) => new TextEncoder().encode(s).length;

export function validatePassword(pw: string, field = 'password'): FieldErrors {
  if (pw.length < PASSWORD_MIN) return { [field]: `Mínimo ${PASSWORD_MIN} caracteres (llevás ${pw.length}).` };
  if (byteLength(pw) > PASSWORD_MAX_BYTES) return { [field]: `No puede superar ${PASSWORD_MAX_BYTES} bytes.` };
  return {};
}

/**
 * Indicador simple de fortaleza (no sustituye la validación del servidor): 0 = no llega al mínimo,
 * 1 = aceptable (>=12), 2 = buena (>=16 o 3 tipos de carácter), 3 = muy buena (ambas).
 */
export function passwordStrength(pw: string): { ratio: number; ok: boolean; level: 0 | 1 | 2 | 3; label: string; text: string } {
  const ok = pw.length >= PASSWORD_MIN;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  const level = !ok ? 0 : ((1 + (pw.length >= 16 ? 1 : 0) + (classes >= 3 ? 1 : 0)) as 1 | 2 | 3);
  const label = ['Muy corta', 'Aceptable', 'Buena', 'Muy buena'][level]!;
  return {
    ratio: Math.min(1, pw.length / PASSWORD_MIN),
    ok,
    level,
    label,
    text: ok ? `${label} (${pw.length} caracteres)` : `${pw.length} de ${PASSWORD_MIN} caracteres mínimos`,
  };
}

export function validatePlantId(id: string): string | null {
  if (!id) return 'El id es obligatorio.';
  if (!ID_PATTERN.test(id)) return 'Usá minúsculas, números, "-" o "_" (máx. 64), empezando por letra o número.';
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
  else if (name.length > 100) e.name = 'Máximo 100 caracteres.';
  return e;
}

export interface UserForm {
  email: string;
  password: string;
  role: Role | '';
  plants: string[];
  /** Cliente elegido (sólo lo usa un `platform_admin`). */
  orgId?: string;
}

/**
 * `actorRole`: quién crea al usuario. Un `platform_admin` debe elegir cliente (salvo que cree otro
 * `platform_admin`, que no tiene cliente); un administrador de cliente no puede otorgar `platform_admin`.
 */
export function validateUserForm(
  v: UserForm,
  opts: { actorRole?: Role } = {},
): { errors: FieldErrors; value?: { email: string; password: string; role: Role; plants: string[]; orgId?: string } } {
  const actor = opts.actorRole ?? 'admin';
  const errors: FieldErrors = {};
  const email = v.email.trim().toLowerCase();
  if (!email) errors.email = 'El correo es obligatorio.';
  else if (!EMAIL.test(email) || email.length > 254) errors.email = 'Ingresá un correo válido (nombre@dominio.com).';
  Object.assign(errors, validatePassword(v.password));
  if (!ROLES.includes(v.role as Role)) errors.role = 'Elegí un rol.';
  else if (v.role === 'platform_admin' && actor !== 'platform_admin') errors.role = 'Sólo el personal de Campos Ingeniería puede otorgar este rol.';
  if (v.plants.some((p) => !ID_PATTERN.test(p))) errors.plants = 'Alguna planta no es válida.';
  const needsOrg = actor === 'platform_admin' && v.role !== '' && v.role !== 'platform_admin';
  if (needsOrg && !v.orgId) errors.orgId = 'Elegí el cliente al que pertenece.';
  if (hasErrors(errors)) return { errors };
  const role = v.role as Role;
  const plants = role === 'platform_admin' ? [] : [...new Set(v.plants)];
  return { errors, value: { email, password: v.password, role, plants, ...(needsOrg && { orgId: v.orgId }) } };
}

// ── Clientes ──

export function validateOrgId(id: string): string | null {
  if (!id) return 'El id es obligatorio.';
  if (!ID_PATTERN.test(id)) return 'Usá minúsculas, números, "-" o "_" (máx. 64), empezando por letra o número.';
  return null;
}

export interface OrgForm {
  id: string;
  name: string;
  modules: ModuleId[];
}

/** Alta/edición de un cliente: id (sólo al crear), nombre y al menos un módulo conocido. */
export function validateOrgForm(v: OrgForm, opts: { editing?: boolean } = {}): FieldErrors {
  const e: FieldErrors = {};
  if (!opts.editing) {
    const idErr = validateOrgId(v.id.trim());
    if (idErr) e.id = idErr;
  }
  const name = v.name.trim();
  if (!name) e.name = 'El nombre es obligatorio.';
  else if (name.length > 100) e.name = 'Máximo 100 caracteres.';
  if (v.modules.some((m) => !MODULE_IDS.includes(m))) e.modules = 'Hay un módulo que no existe.';
  else if (v.modules.length === 0) e.modules = 'Elegí al menos un módulo.';
  return e;
}

/** Primer administrador de un cliente: correo y contraseña. */
export function validateOrgAdminForm(v: { email: string; password: string }): { errors: FieldErrors; value?: { email: string; password: string } } {
  const errors: FieldErrors = {};
  const email = v.email.trim().toLowerCase();
  if (!email) errors.email = 'El correo es obligatorio.';
  else if (!EMAIL.test(email) || email.length > 254) errors.email = 'Ingresá un correo válido (nombre@dominio.com).';
  Object.assign(errors, validatePassword(v.password));
  if (hasErrors(errors)) return { errors };
  return { errors, value: { email, password: v.password } };
}

export function validatePasswordChange(v: { current: string; next: string; confirm: string }): FieldErrors {
  const e: FieldErrors = {};
  if (!v.current) e.current = 'Ingresá tu contraseña actual.';
  Object.assign(e, validatePassword(v.next, 'next'));
  if (!e.next && v.next === v.current) e.next = 'La nueva contraseña debe ser distinta de la actual.';
  if (!v.confirm) e.confirm = 'Repetí la nueva contraseña.';
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
      return { ok: false, error: `JSON no válido (línea ${line}, columna ${col}). Revisá comas, comillas dobles y llaves.` };
    }
    const tok = /Unexpected token '(.+?)'/.exec(msg);
    if (tok) return { ok: false, error: `JSON no válido: carácter inesperado «${tok[1]}». Revisá comas, comillas dobles y llaves.` };
    if (/end of JSON|Unexpected end/i.test(msg)) return { ok: false, error: 'JSON no válido: termina antes de tiempo (falta cerrar una llave o comilla).' };
    return { ok: false, error: 'JSON no válido. Revisá comas, comillas dobles y llaves.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Los metadatos deben ser un objeto JSON, p. ej. {"capacityL": 5000}.' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Campos de `metadata.layout` como texto (lo que se escribe en los inputs). */
export interface LayoutForm {
  x: string;
  z: string;
  y: string;
  rotY: string;
  scale: string;
}
export const emptyLayoutForm = (): LayoutForm => ({ x: '', z: '', y: '', rotY: '', scale: '' });

export interface AssetForm {
  id: string;
  name: string;
  type: AssetType | '';
  /** '' = modelo procedural según el tipo; `model:<uuid>` = modelo GLB de la planta */
  model3dRef: string;
  layout: LayoutForm;
  connectsTo: string[];
  metadataText: string;
  /** Campos de dominio opcionales; si falta, no se tocan los metadatos de dominio. */
  domain?: DomainForm;
  /** Tag estándar (§14.1), p. ej. `TNK-101`; vacío = sin tag. Si falta (`undefined`), no se toca. */
  tag?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Número desde texto de formulario (admite coma decimal). `undefined` si está vacío, `NaN` si no es un número. */
export function parseNum(s: string): number | undefined {
  const t = s.trim().replace(',', '.');
  if (t === '') return undefined;
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) ? Number(t) : NaN;
}

const LAYOUT_FIELDS: { key: keyof LayoutForm; label: string; min?: number; max?: number }[] = [
  { key: 'x', label: 'Posición X', min: -LAYOUT_LIMITS.pos, max: LAYOUT_LIMITS.pos },
  { key: 'z', label: 'Posición Z', min: -LAYOUT_LIMITS.pos, max: LAYOUT_LIMITS.pos },
  { key: 'y', label: 'Altura Y', min: -LAYOUT_LIMITS.pos, max: LAYOUT_LIMITS.pos },
  { key: 'rotY', label: 'Rotación' },
  { key: 'scale', label: 'Escala', min: LAYOUT_LIMITS.scaleMin, max: LAYOUT_LIMITS.scaleMax },
];
const fmt = (n: number) => String(n).replace('.', ',');

/**
 * Valida los campos de disposición. `value`: `null` si están todos vacíos (sin layout propio) o el layout
 * listo para guardar. Los errores se indexan como `layout` (conjunto) o `layoutX`, `layoutZ`, `layoutY`, `layoutRotY`, `layoutScale`.
 */
export function validateLayoutForm(f: LayoutForm): { errors: FieldErrors; value?: AssetLayout | null } {
  const errors: FieldErrors = {};
  const nums: Partial<Record<keyof LayoutForm, number>> = {};
  for (const { key, label, min, max } of LAYOUT_FIELDS) {
    const v = parseNum(f[key]);
    if (v === undefined) continue;
    const name = `layout${key[0]!.toUpperCase()}${key.slice(1)}`;
    if (!Number.isFinite(v)) errors[name] = `${label}: ingresá un número.`;
    else if (min !== undefined && max !== undefined && (v < min || v > max)) errors[name] = `${label}: entre ${fmt(min)} y ${fmt(max)}.`;
    else nums[key] = v;
  }
  if (hasErrors(errors)) return { errors };
  const any = Object.keys(nums).length > 0;
  if (!any) return { errors, value: null };
  if (nums.x === undefined || nums.z === undefined) {
    errors[nums.x === undefined ? 'layoutX' : 'layoutZ'] = 'Indicá X y Z para colocar el activo (o vaciá todos los campos para usar la posición automática).';
    return { errors };
  }
  const layout: AssetLayout = { x: nums.x, z: nums.z };
  if (nums.y !== undefined) layout.y = nums.y;
  if (nums.rotY !== undefined) layout.rotY = nums.rotY;
  if (nums.scale !== undefined) layout.scale = nums.scale;
  return { errors, value: layout };
}

/** Texto de los campos a partir de `metadata.layout` (si es válido o, al menos, numérico). */
export function layoutFormFrom(metadata: unknown): LayoutForm {
  const raw = isObj(metadata) && isObj(metadata.layout) ? metadata.layout : undefined;
  const out = emptyLayoutForm();
  if (!raw) return out;
  for (const { key } of LAYOUT_FIELDS) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = String(v);
  }
  return out;
}

/** Problemas de `metadata.layout` y `metadata.connectsTo` (mismos límites que la API, §10.3). Vacío = correcto. */
export function validateMetadataLayout(metadata: unknown, selfId?: string): string[] {
  if (!isObj(metadata)) return [];
  const out: string[] = [];
  if (metadata.layout !== undefined) {
    const l = metadata.layout;
    if (!isObj(l)) out.push('layout debe ser un objeto {x, z, y?, rotY?, scale?}.');
    else if (!parseLayout(metadata)) {
      out.push(
        `layout no es válido: x y z son obligatorios (|valor| ≤ ${LAYOUT_LIMITS.pos}), y también |y| ≤ ${LAYOUT_LIMITS.pos}, rotY en grados y escala entre ${LAYOUT_LIMITS.scaleMin} y ${LAYOUT_LIMITS.scaleMax}.`,
      );
    }
  }
  const c = metadata.connectsTo;
  if (c !== undefined) {
    if (!Array.isArray(c) || c.some((x) => typeof x !== 'string' || !ID_PATTERN.test(x))) out.push('connectsTo debe ser una lista de ids de activo.');
    else {
      if (c.length > LAYOUT_LIMITS.maxConnections) out.push(`connectsTo admite como máximo ${LAYOUT_LIMITS.maxConnections} activos.`);
      if (new Set(c).size !== c.length) out.push('connectsTo no admite ids repetidos.');
      if (selfId && c.includes(selfId)) out.push('connectsTo no puede incluir al propio activo.');
    }
  }
  return out;
}

/**
 * Escribe `layout` y `connectsTo` en una copia de los metadatos SIN tocar el resto de claves.
 * `layout`: `undefined` = no tocar, `null` = quitar. `connectsTo`: `undefined` = no tocar, `[]` = quitar.
 */
export function mergeLayoutIntoMetadata(
  meta: Record<string, unknown>,
  layout: AssetLayout | null | undefined,
  connectsTo: readonly string[] | undefined,
): Record<string, unknown> {
  const out = { ...meta };
  if (layout === null) delete out.layout;
  else if (layout) out.layout = layout;
  if (connectsTo && connectsTo.length === 0) delete out.connectsTo;
  else if (connectsTo) out.connectsTo = [...connectsTo];
  return out;
}

/** Reescribe el JSON avanzado con la disposición de los campos; `null` si el JSON actual no es válido (no se toca). */
export function syncMetadataText(
  text: string,
  layout: AssetLayout | null | undefined,
  connectsTo: readonly string[] | undefined,
): string | null {
  const parsed = parseMetadata(text);
  if (!parsed.ok) return null;
  const merged = mergeLayoutIntoMetadata(parsed.value, layout, connectsTo);
  return Object.keys(merged).length === 0 ? '' : JSON.stringify(merged, null, 2);
}

/** Campos estructurados a partir del JSON avanzado; `null` si no es válido. */
export function fieldsFromMetadataText(text: string): { layout: LayoutForm; connectsTo: string[] } | null {
  const parsed = parseMetadata(text);
  if (!parsed.ok) return null;
  return { layout: layoutFormFrom(parsed.value), connectsTo: parseConnectsTo(parsed.value) };
}

// ── Campos de dominio (docs §11.2): capacityM3, contractedKw, scale ──

export interface ScaleForm {
  min: string;
  max: string;
}
/** `metadata.control` (§14.3), como texto de formulario. */
export interface ControlForm {
  enabled: boolean;
  minTarget: string;
  maxTarget: string;
  maxDurationMinutes: string;
}
export const emptyControlForm = (): ControlForm => ({ enabled: false, minTarget: '', maxTarget: '', maxDurationMinutes: '' });

export interface DomainForm {
  capacityM3: string;
  contractedKw: string;
  scale: Record<string, ScaleForm>;
  /** Control de llenado (tanques y silos). Si falta, no se toca `metadata.control`. */
  control?: ControlForm;
}
export const emptyDomainForm = (): DomainForm => ({ capacityM3: '', contractedKw: '', scale: {}, control: emptyControlForm() });

/** Tipos que admiten control de llenado (nivel). */
export const CONTROL_TYPES: readonly AssetType[] = ['tank', 'silo'];
export const supportsControl = (type: AssetType | ''): boolean => type !== '' && CONTROL_TYPES.includes(type);

/** Límites razonables del contrato (§14.3): objetivos 1–99 %, duración máxima en minutos. */
export const CONTROL_LIMITS = { targetMin: 1, targetMax: 99, durationMax: 1440 } as const;

/** Valores listos para escribir en los metadatos: `undefined` = no tocar, `null` = quitar la clave. */
export interface DomainValues {
  capacityM3?: number | null;
  contractedKw?: number | null;
  scale?: Record<string, { min: number; max: number } | null>;
  control?: ControlConfig | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Campos (como texto) a partir de `metadata`; sólo toma valores numéricos. */
export function domainFormFrom(metadata: unknown): DomainForm {
  const out = emptyDomainForm();
  if (!isObj(metadata)) return out;
  if (isNum(metadata.capacityM3)) out.capacityM3 = String(metadata.capacityM3);
  if (isNum(metadata.contractedKw)) out.contractedKw = String(metadata.contractedKw);
  if (isObj(metadata.scale)) {
    for (const [metric, r] of Object.entries(metadata.scale)) {
      if (isObj(r) && isNum(r.min) && isNum(r.max)) out.scale[metric] = { min: String(r.min), max: String(r.max) };
    }
  }
  const c = metadata.control;
  if (isObj(c)) {
    out.control = {
      enabled: c.enabled === true,
      minTarget: isNum(c.minTarget) ? String(c.minTarget) : '',
      maxTarget: isNum(c.maxTarget) ? String(c.maxTarget) : '',
      maxDurationMinutes: isNum(c.maxDurationMinutes) ? String(c.maxDurationMinutes) : '',
    };
  }
  return out;
}

/**
 * Valida el formulario de control. `value`: la configuración lista para guardar; `null` si el control está apagado y sin
 * valores (se quita la clave). Errores: `controlMin`, `controlMax`, `controlDuration`.
 */
export function validateControlForm(f: ControlForm): { errors: FieldErrors; value: ControlConfig | null } {
  const errors: FieldErrors = {};
  const min = parseNum(f.minTarget);
  const max = parseNum(f.maxTarget);
  const dur = parseNum(f.maxDurationMinutes);
  const inRange = (n: number) => n >= CONTROL_LIMITS.targetMin && n <= CONTROL_LIMITS.targetMax;
  if (min !== undefined && (!Number.isFinite(min) || !inRange(min))) errors.controlMin = `El objetivo mínimo tiene que estar entre ${CONTROL_LIMITS.targetMin} y ${CONTROL_LIMITS.targetMax} %.`;
  if (max !== undefined && (!Number.isFinite(max) || !inRange(max))) errors.controlMax = `El objetivo máximo tiene que estar entre ${CONTROL_LIMITS.targetMin} y ${CONTROL_LIMITS.targetMax} %.`;
  if (!errors.controlMin && !errors.controlMax && min !== undefined && max !== undefined && min >= max) errors.controlMax = 'El máximo tiene que ser mayor que el mínimo.';
  if (dur !== undefined && (!Number.isFinite(dur) || !Number.isInteger(dur) || dur < 1 || dur > CONTROL_LIMITS.durationMax)) {
    errors.controlDuration = `La duración máxima son minutos enteros, entre 1 y ${CONTROL_LIMITS.durationMax}.`;
  }
  if (Object.keys(errors).length > 0) return { errors, value: null };
  if (!f.enabled && min === undefined && max === undefined && dur === undefined) return { errors, value: null };
  const value: ControlConfig = { enabled: f.enabled };
  if (min !== undefined) value.minTarget = min;
  if (max !== undefined) value.maxTarget = max;
  if (dur !== undefined) value.maxDurationMinutes = dur;
  return { errors, value };
}

/** Contadores acumulados: no tienen barra de rango (siempre crecen). */
const COUNTERS = new Set(['kwh', 'total']);

/** Métricas con barra de rango editable para un tipo de activo. */
export const scaleMetricsFor = (type: AssetType | ''): string[] =>
  type && type in ASSET_KINDS ? ASSET_KINDS[type].metrics.filter((m) => m in METRICS && !COUNTERS.has(m)) : [];

/** Valida los campos de dominio que corresponden al tipo. Errores: `capacityM3`, `contractedKw`, `scale:<métrica>`. */
export function validateDomainForm(f: DomainForm, type: AssetType | ''): { errors: FieldErrors; value: DomainValues } {
  const errors: FieldErrors = {};
  const value: DomainValues = {};
  const positive = (key: 'capacityM3' | 'contractedKw', label: string) => {
    const n = parseNum(f[key]);
    if (n === undefined) value[key] = null;
    else if (!Number.isFinite(n) || n <= 0) errors[key] = `${label}: ingresá un número mayor que 0.`;
    else value[key] = n;
  };
  if (type === 'tank' || type === 'silo') positive('capacityM3', 'Capacidad');
  if (type === 'energy') positive('contractedKw', 'Potencia contratada');
  const scale: NonNullable<DomainValues['scale']> = {};
  for (const metric of scaleMetricsFor(type)) {
    const r = f.scale[metric] ?? { min: '', max: '' };
    const min = parseNum(r.min);
    const max = parseNum(r.max);
    const label = METRICS[metric]!.label;
    if (min === undefined && max === undefined) scale[metric] = null;
    else if (min === undefined || max === undefined) errors[`scale:${metric}`] = `${label}: completá el mínimo y el máximo (o vaciá los dos).`;
    else if (!Number.isFinite(min) || !Number.isFinite(max)) errors[`scale:${metric}`] = `${label}: ingresá números.`;
    else if (min >= max) errors[`scale:${metric}`] = `${label}: el mínimo tiene que ser menor que el máximo.`;
    else scale[metric] = { min, max };
  }
  value.scale = scale;
  if (supportsControl(type) && f.control) {
    const c = validateControlForm(f.control);
    Object.assign(errors, c.errors);
    value.control = c.value;
  }
  return { errors, value: hasErrors(errors) ? {} : value };
}

/** Problemas de `capacityM3`, `contractedKw` y `scale` escritos a mano en el JSON. Vacío = correcto. */
export function validateMetadataDomain(metadata: unknown): string[] {
  if (!isObj(metadata)) return [];
  const out: string[] = [];
  for (const key of ['capacityM3', 'contractedKw'] as const) {
    const v = metadata[key];
    if (v !== undefined && (!isNum(v) || v <= 0)) out.push(`${key} debe ser un número mayor que 0.`);
  }
  const sc = metadata.scale;
  if (sc !== undefined) {
    if (!isObj(sc)) out.push('scale debe ser un objeto {métrica: {min, max}}.');
    else {
      for (const [metric, r] of Object.entries(sc)) {
        if (!RULE_METRIC_PATTERN.test(metric)) out.push(`scale: «${metric}» no es un nombre de métrica válido.`);
        else if (!isObj(r) || !isNum(r.min) || !isNum(r.max)) out.push(`scale.${metric} debe tener min y max numéricos.`);
        else if (r.min >= r.max) out.push(`scale.${metric}: min tiene que ser menor que max.`);
      }
    }
  }
  const c = metadata.control;
  if (c !== undefined) {
    if (!isObj(c)) out.push('control debe ser un objeto {enabled, minTarget?, maxTarget?, maxDurationMinutes?}.');
    else {
      if (typeof c.enabled !== 'boolean') out.push('control.enabled debe ser verdadero o falso.');
      for (const key of ['minTarget', 'maxTarget'] as const) {
        const v = c[key];
        if (v !== undefined && (!isNum(v) || v < CONTROL_LIMITS.targetMin || v > CONTROL_LIMITS.targetMax)) out.push(`control.${key} tiene que estar entre ${CONTROL_LIMITS.targetMin} y ${CONTROL_LIMITS.targetMax}.`);
      }
      if (isNum(c.minTarget) && isNum(c.maxTarget) && c.minTarget >= c.maxTarget) out.push('control.minTarget tiene que ser menor que control.maxTarget.');
      const d = c.maxDurationMinutes;
      if (d !== undefined && (!isNum(d) || !Number.isInteger(d) || d < 1 || d > CONTROL_LIMITS.durationMax)) out.push('control.maxDurationMinutes tiene que ser un número entero de minutos.');
    }
  }
  return out;
}

/** Escribe los valores de dominio en una copia de los metadatos SIN tocar el resto de claves (ni otras métricas de `scale`). */
export function mergeDomainIntoMetadata(meta: Record<string, unknown>, values: DomainValues): Record<string, unknown> {
  const out = { ...meta };
  for (const key of ['capacityM3', 'contractedKw'] as const) {
    if (values[key] === null) delete out[key];
    else if (values[key] !== undefined) out[key] = values[key];
  }
  if (values.scale) {
    const scale: Record<string, unknown> = isObj(out.scale) ? { ...out.scale } : {};
    for (const [metric, r] of Object.entries(values.scale)) {
      if (r === null) delete scale[metric];
      else scale[metric] = r;
    }
    if (Object.keys(scale).length === 0) delete out.scale;
    else out.scale = scale;
  }
  if (values.control === null) delete out.control;
  else if (values.control) out.control = values.control;
  return out;
}

/** Reescribe el JSON avanzado con los campos de dominio; `null` si el JSON actual no es válido (no se toca). */
export function syncDomainIntoText(text: string, values: DomainValues): string | null {
  const parsed = parseMetadata(text);
  if (!parsed.ok) return null;
  const merged = mergeDomainIntoMetadata(parsed.value, values);
  return Object.keys(merged).length === 0 ? '' : JSON.stringify(merged, null, 2);
}

/** Campos de dominio a partir del JSON avanzado; `null` si no es válido. */
export function domainFromMetadataText(text: string): DomainForm | null {
  const parsed = parseMetadata(text);
  return parsed.ok ? domainFormFrom(parsed.value) : null;
}

/** Métricas que se pueden usar en una regla según el tipo de los activos que abarca (`pattern` vacío = todos). */
export function metricsForAssets(pattern: string, assets: readonly Pick<AssetDef, 'id' | 'type'>[]): string[] {
  const p = pattern.trim();
  const out = new Set<string>();
  for (const a of assets) {
    if (p && !ruleMatchesAsset(p, a.id)) continue;
    for (const m of ASSET_KINDS[a.type]?.metrics ?? []) out.add(m);
  }
  return [...out];
}

/** "Nivel (%)", "Factor de potencia"; para métricas desconocidas, el propio id. */
export function metricLabel(metric: string): string {
  const m = METRICS[metric];
  return m ? `${m.label}${m.unit ? ` (${m.unit})` : ''}` : metric;
}

/**
 * `keepRef`: valor antiguo de `model3dRef` (texto libre) que la API tolera reenviar tal cual mientras no se cambie.
 * `modules`: módulos contratados por el cliente (si se indica, un tipo de otro módulo se rechaza);
 * `originalType`: tipo actual al editar (no se vuelve a exigir el módulo si no se cambia).
 */
export function validateAssetForm(
  v: AssetForm,
  opts: {
    editing?: boolean;
    keepRef?: string | null;
    modules?: readonly ModuleId[];
    originalType?: AssetType;
    /** Los demás activos de la planta, para detectar un tag repetido. */
    others?: readonly Pick<AssetDef, 'id' | 'tag'>[];
  } = {},
): { errors: FieldErrors; value?: AssetInput } {
  const errors: FieldErrors = {};
  const id = v.id.trim();
  if (!opts.editing) {
    const idErr = validatePlantId(id);
    if (idErr) errors.id = idErr;
  }
  const name = v.name.trim();
  if (!name) errors.name = 'El nombre es obligatorio.';
  else if (name.length > 100) errors.name = 'Máximo 100 caracteres.';
  if (v.tag !== undefined) {
    const tagErr = validateTag(v.tag, opts.others ?? [], opts.editing ? id : undefined);
    if (tagErr) errors.tag = tagErr;
  }
  if (!ASSET_TYPES.includes(v.type as AssetType)) errors.type = 'Elegí un tipo.';
  else if (opts.modules && v.type !== opts.originalType && !isTypeAllowed(v.type as AssetType, opts.modules)) errors.type = MODULE_DISABLED_TEXT;
  const ref = v.model3dRef.trim();
  if (ref && !MODEL_REF_PATTERN.test(ref) && ref !== opts.keepRef) errors.model3dRef = 'Elegí un modelo de la lista o dejalo en «Procedural».';
  const meta = parseMetadata(v.metadataText);
  if (!meta.ok) errors.metadata = meta.error;
  else {
    const problems = [...validateMetadataLayout(meta.value, id || undefined), ...validateMetadataDomain(meta.value)];
    if (problems.length > 0) errors.metadata = problems.join(' ');
  }
  const layout = validateLayoutForm(v.layout);
  Object.assign(errors, layout.errors);
  const domain = v.domain ? validateDomainForm(v.domain, v.type) : null;
  if (domain) Object.assign(errors, domain.errors);
  if (v.connectsTo.length > LAYOUT_LIMITS.maxConnections) errors.connectsTo = `Como máximo ${LAYOUT_LIMITS.maxConnections} conexiones.`;
  else if (id && v.connectsTo.includes(id)) errors.connectsTo = 'Un activo no puede conectarse consigo mismo.';
  if (hasErrors(errors) || !meta.ok || layout.value === undefined) return { errors };
  let metadata = mergeLayoutIntoMetadata(meta.value, layout.value, v.connectsTo);
  if (domain) metadata = mergeDomainIntoMetadata(metadata, domain.value);
  const value: AssetInput = { id, name, type: v.type as AssetType, model3dRef: ref || null, metadata };
  if (v.tag !== undefined) value.tag = v.tag.trim() === '' ? null : v.tag.trim().toUpperCase();
  return { errors, value };
}

/** ¿El cliente puede crear activos de este tipo? Los genéricos (sin módulo) siempre. */
export function isTypeAllowed(type: AssetType, modules: readonly ModuleId[]): boolean {
  const m = moduleForAssetType(type);
  return m === null || modules.includes(m);
}

/** ¿El patrón de una regla (`tk-*`) nombra/abarca este activo? Sólo `*` es comodín. */
export function ruleMatchesAsset(pattern: string, assetId: string): boolean {
  if (!pattern.includes('*')) return pattern === assetId;
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(assetId);
}
