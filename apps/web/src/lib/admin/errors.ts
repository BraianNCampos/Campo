import { MODULES, type ModuleId } from '@campo/shared';
import { ApiError } from '@/lib/auth';

export type ApiErrorKind =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'network'
  | 'server'
  | 'unknown';

/** Error de la API de administración: `message` siempre es legible, en español y sin trazas. */
export class AdminApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly kind: ApiErrorKind,
    /** Lista legible (errores de validación 400). */
    readonly details: string[] = [],
    /** Campo (nombre del DTO) → mensaje, para marcar el control correspondiente. */
    readonly fields: Record<string, string> = {},
  ) {
    super(message, status);
    this.name = 'AdminApiError';
  }
}

const FIELD_LABELS: Record<string, string> = {
  email: 'Correo',
  password: 'Contraseña',
  currentPassword: 'Contraseña actual',
  newPassword: 'Contraseña nueva',
  role: 'Rol',
  active: 'Estado',
  plants: 'Plantas',
  plant: 'Planta',
  asset: 'Activo',
  metric: 'Métrica',
  operator: 'Operador',
  threshold: 'Umbral',
  severity: 'Severidad',
  forSeconds: 'Duración (s)',
  hysteresis: 'Histéresis',
  enabled: 'Activa',
  name: 'Nombre',
  orgId: 'Cliente',
  modules: 'Módulos',
  type: 'Tipo',
  id: 'Id',
  model3dRef: 'Modelo 3D',
  metadata: 'Metadatos',
  limit: 'Límite',
  before: 'Cursor',
};

const label = (f: string) => FIELD_LABELS[f] ?? f;

/** Traduce un mensaje de class-validator. Devuelve el campo (si se conoce) y el texto en español. */
export function humanizeValidation(raw: string): { field?: string; text: string } {
  const m = raw.trim();
  const prop = /^property (\w+) should not exist$/.exec(m);
  if (prop) return { field: prop[1], text: `Campo no permitido: ${prop[1]}` };

  const lead = /^(\w+)[\s:]/.exec(m);
  const field = lead && lead[1] && lead[1] in FIELD_LABELS ? lead[1] : undefined;
  if (!field) return { text: m };
  const L = label(field);
  const rest = m.slice(field.length).replace(/^:?\s*/, '');
  const rules: [RegExp, (r: RegExpExecArray) => string][] = [
    [/^must be an email$/, () => `${L}: no es una dirección de correo válida`],
    [/^must be a string$/, () => `${L}: debe ser texto`],
    [/^must be a number conforming/, () => `${L}: debe ser un número`],
    [/^must be an integer number$/, () => `${L}: debe ser un número entero`],
    [/^must be a boolean value$/, () => `${L}: debe ser verdadero o falso`],
    [/^must be an array$/, () => `${L}: debe ser una lista`],
    [/^must be an object$/, () => `${L}: debe ser un objeto`],
    [/^must be a UUID/, () => `${L}: identificador no válido`],
    [/^must not be less than (.+)$/, (r) => `${L}: no puede ser menor que ${r[1]}`],
    [/^must not be greater than (.+)$/, (r) => `${L}: no puede ser mayor que ${r[1]}`],
    [/^must be longer than or equal to (\d+) characters$/, (r) => `${L}: mínimo ${r[1]} caracteres`],
    [/^must be shorter than or equal to (\d+) characters$/, (r) => `${L}: máximo ${r[1]} caracteres`],
    [/^must be one of the following values: (.+)$/, (r) => `${L}: valor no permitido (admitidos: ${r[1]})`],
    [/^must match .* regular expression$/, () => `${L}: formato no válido`],
    [/^should not be empty$/, () => `${L}: es obligatorio`],
    [/^array contains duplicate values$/, () => `${L}: contiene valores repetidos`],
    [/^an array of .*$/, () => `${L}: valores no válidos`],
  ];
  for (const [re, fmt] of rules) {
    const r = re.exec(rest);
    if (r) return { field, text: fmt(r) };
  }
  // mensaje ya en español ("password debe tener al menos 12 caracteres"): sólo se sustituye el nombre del campo
  return { field, text: `${L}${m.slice(field.length)}` };
}

const ENGLISH_DEFAULTS = new Set([
  'forbidden',
  'forbidden resource',
  'not found',
  'conflict',
  'unauthorized',
  'bad request',
  'internal server error',
  'too many requests',
  'service unavailable',
  'payload too large',
  'request entity too large',
  'bad gateway',
  'gateway timeout',
]);

const DEFAULT_TEXT: Record<number, string> = {
  400: 'Los datos enviados no son válidos.',
  401: 'Tu sesión caducó. Iniciá sesión de nuevo.',
  403: 'No tenés permisos para hacer esto.',
  404: 'No se encontró lo que buscabas.',
  409: 'La operación choca con el estado actual.',
  413: 'El archivo supera el tamaño máximo permitido (10 MB).',
  429: 'Demasiados pedidos. Esperá un momento y volvé a intentar.',
};

export function kindForStatus(status: number): ApiErrorKind {
  if (status === 0) return 'network';
  if (status === 400 || status === 422) return 'validation';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** Construye el error a partir de la respuesta JSON de NestJS (`{statusCode,message,error}`); nunca expone trazas. */
export function errorFromResponse(status: number, body: unknown): AdminApiError {
  const kind = kindForStatus(status);
  if (status === 403) {
    const moduleError = moduleDisabledFrom(body);
    if (moduleError) return moduleError;
  }
  const rawMsg =
    typeof body === 'object' && body !== null && 'message' in body ? (body as { message: unknown }).message : undefined;
  const messages = (Array.isArray(rawMsg) ? rawMsg : [rawMsg]).filter(
    (x): x is string => typeof x === 'string' && x.trim() !== '' && x.length <= 300,
  );

  if (kind === 'validation') {
    const parsed = messages.filter((m) => !ENGLISH_DEFAULTS.has(m.trim().toLowerCase())).map(humanizeValidation); // «Bad Request» a secas no dice nada
    const details = parsed.length > 0 ? parsed.map((p) => p.text) : [DEFAULT_TEXT[400]!];
    const fields: Record<string, string> = {};
    for (const p of parsed) if (p.field && !fields[p.field]) fields[p.field] = p.text;
    const message = details.length === 1 ? details[0]! : 'Revisá los datos del formulario.';
    return new AdminApiError(message, status, kind, details, fields);
  }
  const first = messages[0];
  const useServerText = first && !ENGLISH_DEFAULTS.has(first.trim().toLowerCase());
  const text =
    kind === 'server'
      ? `Error del servidor (${status}). Intentá de nuevo en unos minutos.`
      : useServerText
        ? first
        : (DEFAULT_TEXT[status] ?? `Error inesperado (${status}).`);
  return new AdminApiError(text, status, kind);
}

export const MODULE_DISABLED_TEXT = 'Este módulo no está contratado, pedíselo a Campos Ingeniería.';

/** 403 `{error:"module_disabled", module}`: el cliente no contrató el módulo del tipo de activo (docs §11.2). */
export class ModuleDisabledError extends AdminApiError {
  constructor(readonly module: string | null) {
    super(MODULE_DISABLED_TEXT, 403, 'forbidden', [], { type: MODULE_DISABLED_TEXT });
    this.name = 'ModuleDisabledError';
  }

  /** Nombre legible del módulo (si es uno conocido). */
  get moduleLabel(): string | null {
    return MODULES.find((m) => m.id === (this.module as ModuleId))?.label ?? null;
  }
}

function moduleDisabledFrom(body: unknown): ModuleDisabledError | null {
  if (typeof body !== 'object' || body === null) return null;
  const rec = body as Record<string, unknown>;
  const flagged = rec.error === 'module_disabled' || rec.message === 'module_disabled';
  if (!flagged) return null;
  return new ModuleDisabledError(typeof rec.module === 'string' ? rec.module : null);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** 409 al borrar un cliente que todavía tiene plantas o usuarios (docs §11.1). Los contadores pueden ser `null` si la API no los informa. */
export class OrgNotEmptyError extends AdminApiError {
  constructor(
    readonly plants: number | null,
    readonly users: number | null,
  ) {
    const parts = [plants ? plural(plants, 'planta', 'plantas') : null, users ? plural(users, 'usuario', 'usuarios') : null].filter(Boolean);
    const what = parts.length > 0 ? `Todavía tiene ${parts.join(' y ')}` : 'Todavía tiene plantas o usuarios';
    super(`No se puede borrar el cliente. ${what}: eliminalos o pasalos a otro cliente antes de borrarlo.`, 409, 'conflict');
    this.name = 'OrgNotEmptyError';
  }
}

const countOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) ? v.length : null);

/** Lee `{plants, users}` (números o listas) del cuerpo de un 409 al borrar un cliente. */
export function orgNotEmptyFrom(body: unknown): OrgNotEmptyError {
  const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return new OrgNotEmptyError(countOf(rec.plants), countOf(rec.users));
}

/** 409 al borrar un modelo que usan activos. El contrato no fija la forma del cuerpo: se aceptan varias. */
export class ModelInUseError extends AdminApiError {
  constructor(readonly assets: string[]) {
    const list = assets.length > 0 ? `: ${assets.join(', ')}` : '';
    super(
      `El modelo está en uso por ${assets.length === 1 ? 'el activo' : assets.length > 1 ? `${assets.length} activos` : 'uno o más activos'}${list}. Cambiá su modelo 3D antes de borrarlo.`,
      409,
      'conflict',
    );
    this.name = 'ModelInUseError';
  }
}

const USED_BY_KEYS = ['assets', 'usedBy', 'referencedBy', 'assetIds'] as const;

/** Extrae los ids de activo del cuerpo de un 409 (`{assets:[...]}`, `{usedBy:[{id}]}`…). */
export function assetsFromConflict(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const rec = body as Record<string, unknown>;
  for (const key of USED_BY_KEYS) {
    const v = rec[key];
    if (!Array.isArray(v)) continue;
    const ids = v
      .map((x) => (typeof x === 'string' ? x : typeof x === 'object' && x !== null ? ((x as { id?: unknown; asset?: unknown }).id ?? (x as { asset?: unknown }).asset) : undefined))
      .filter((x): x is string => typeof x === 'string' && x !== '');
    if (ids.length > 0) return [...new Set(ids)];
  }
  return [];
}

export const networkError = () =>
  new AdminApiError('No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo.', 0, 'network');

/** Texto de cualquier error capturado, apto para mostrar. */
export function errorMessage(e: unknown): string {
  if (e instanceof AdminApiError) return e.message;
  return 'Ocurrió un error inesperado.';
}
