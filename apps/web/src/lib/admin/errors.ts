import { ApiError } from '@/lib/auth';

export type ApiErrorKind =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
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
  'bad gateway',
  'gateway timeout',
]);

const DEFAULT_TEXT: Record<number, string> = {
  400: 'Los datos enviados no son válidos.',
  401: 'Tu sesión ha caducado. Inicia sesión de nuevo.',
  403: 'No tienes permisos para realizar esta acción.',
  404: 'No se encontró el recurso solicitado.',
  409: 'La operación entra en conflicto con el estado actual.',
  429: 'Demasiadas peticiones. Espera un momento y reinténtalo.',
};

export function kindForStatus(status: number): ApiErrorKind {
  if (status === 0) return 'network';
  if (status === 400 || status === 422) return 'validation';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** Construye el error a partir de la respuesta JSON de NestJS (`{statusCode,message,error}`); nunca expone trazas. */
export function errorFromResponse(status: number, body: unknown): AdminApiError {
  const kind = kindForStatus(status);
  const rawMsg =
    typeof body === 'object' && body !== null && 'message' in body ? (body as { message: unknown }).message : undefined;
  const messages = (Array.isArray(rawMsg) ? rawMsg : [rawMsg]).filter(
    (x): x is string => typeof x === 'string' && x.trim() !== '' && x.length <= 300,
  );

  if (kind === 'validation') {
    const parsed = messages.map(humanizeValidation);
    const details = parsed.length > 0 ? parsed.map((p) => p.text) : [DEFAULT_TEXT[400]!];
    const fields: Record<string, string> = {};
    for (const p of parsed) if (p.field && !fields[p.field]) fields[p.field] = p.text;
    const message = details.length === 1 ? details[0]! : 'Revisa los datos del formulario.';
    return new AdminApiError(message, status, kind, details, fields);
  }
  const first = messages[0];
  const useServerText = first && !ENGLISH_DEFAULTS.has(first.trim().toLowerCase());
  const text =
    kind === 'server'
      ? `Error del servidor (${status}). Inténtalo de nuevo en unos minutos.`
      : useServerText
        ? first
        : (DEFAULT_TEXT[status] ?? `Error inesperado (${status}).`);
  return new AdminApiError(text, status, kind);
}

export const networkError = () =>
  new AdminApiError('No se pudo contactar con el servidor. Revisa tu conexión e inténtalo de nuevo.', 0, 'network');

/** Texto de cualquier error capturado, apto para mostrar. */
export function errorMessage(e: unknown): string {
  if (e instanceof AdminApiError) return e.message;
  return 'Ha ocurrido un error inesperado.';
}
