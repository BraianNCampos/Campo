import { AdminApiError, errorFromResponse } from '@/lib/admin/errors';

/**
 * Errores del control de llenado (§14.3) con mensajes comprensibles. La API responde con códigos como
 * `device_offline`, `order_in_progress` o `control_unavailable`; nunca se muestran en crudo.
 */

export type ControlErrorCode =
  | 'device_offline'
  | 'order_in_progress'
  | 'control_unavailable'
  | 'confirm_expired'
  | 'confirm_invalid'
  | 'rate_limited'
  | 'control_disabled'
  | 'module_disabled'
  | 'forbidden'
  | 'interlock'
  | 'not_found';

export class ControlApiError extends AdminApiError {
  constructor(
    message: string,
    status: number,
    kind: AdminApiError['kind'],
    readonly code: ControlErrorCode | null,
  ) {
    super(message, status, kind);
    this.name = 'ControlApiError';
  }
}

export const CONTROL_TEXT: Record<ControlErrorCode, string> = {
  device_offline: 'El equipo no está enviando datos (hace más de 30 segundos), así que no podemos darle órdenes. Revisá la conexión del equipo y volvé a intentar.',
  order_in_progress: 'Ya hay una orden en curso para este equipo. Esperá a que termine, o detenela primero.',
  control_unavailable: 'El control no está disponible en este momento: el servidor no logra comunicarse con los equipos. Probá de nuevo en unos minutos; si sigue, avisale a Campos Ingeniería.',
  confirm_expired: 'La confirmación venció (dura 60 segundos). Revisá la orden y volvé a confirmarla.',
  confirm_invalid: 'Esa confirmación ya no sirve: se usó, venció o no corresponde a esta orden. Revisá la orden y volvé a confirmarla.',
  rate_limited: 'Mandaste demasiadas órdenes seguidas (el máximo es 10 por minuto). Esperá un momento y volvé a intentar.',
  control_disabled: 'Este equipo no está habilitado para recibir órdenes. Un ingeniero o administrador puede habilitarlo en Administración.',
  module_disabled: 'El módulo «Control de llenado» no está contratado. Para sumarlo, contactá a Campos Ingeniería.',
  forbidden: 'Tu rol no permite dar órdenes. Podés ver el estado y el registro, pero la orden la tiene que dar alguien de operación, ingeniería o administración.',
  interlock: 'Un enclavamiento impide esta orden. Mirá los motivos y corregí lo que haga falta.',
  not_found: 'No encontramos ese equipo u orden. Puede que ya no exista: actualizá la pantalla.',
};

const CODE_ALIASES: Record<string, ControlErrorCode> = {
  device_offline: 'device_offline',
  offline: 'device_offline',
  order_in_progress: 'order_in_progress',
  control_unavailable: 'control_unavailable',
  confirm_expired: 'confirm_expired',
  confirmation_expired: 'confirm_expired',
  confirm_invalid: 'confirm_invalid',
  invalid_confirm: 'confirm_invalid',
  confirm_used: 'confirm_invalid',
  confirm_mismatch: 'confirm_invalid',
  rate_limited: 'rate_limited',
  too_many_requests: 'rate_limited',
  control_disabled: 'control_disabled',
  module_disabled: 'module_disabled',
  interlock: 'interlock',
  interlock_blocked: 'interlock',
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const CODE_LIKE = /^[a-z][a-z0-9_]{2,40}$/;

/** Código de error del cuerpo (`{error:"device_offline"}`, `{code}` o `{message:"device_offline"}`), si lo hay. */
export function codeOf(body: unknown): string | null {
  if (!isObj(body)) return null;
  for (const k of ['error', 'code', 'message'] as const) {
    const v = body[k];
    if (typeof v === 'string' && CODE_LIKE.test(v)) return v;
  }
  return null;
}

/** Texto en español que ya trae el servidor (no un código ni uno de los mensajes en inglés por defecto). */
function serverText(body: unknown): string | null {
  if (!isObj(body)) return null;
  const m = Array.isArray(body.message) ? body.message[0] : body.message;
  if (typeof m !== 'string' || m.length > 300 || CODE_LIKE.test(m)) return null;
  if (/^(forbidden|not found|conflict|unauthorized|bad request|too many requests|service unavailable)/i.test(m)) return null;
  return /[áéíóúñ¿¡ ]/i.test(m) && / /.test(m) ? m : null;
}

/** Traduce una respuesta de error del control (409/429/503/403…) a un error con texto comprensible. */
export function controlErrorFromResponse(status: number, body: unknown): ControlApiError | AdminApiError {
  const raw = codeOf(body);
  const named = raw ? CODE_ALIASES[raw] : undefined;
  const make = (code: ControlErrorCode, kind: AdminApiError['kind'] = status >= 500 ? 'server' : status === 409 ? 'conflict' : status === 403 ? 'forbidden' : 'unknown') =>
    new ControlApiError(CONTROL_TEXT[code], status, kind, code);
  if (named) return make(named);
  if (status === 429) return make('rate_limited', 'unknown');
  if (status === 503) return make('control_unavailable', 'server');
  if (status === 403) return make('forbidden');
  if (status === 404) return make('not_found', 'not_found');
  if (status === 409) {
    const text = serverText(body);
    return text ? new ControlApiError(text, 409, 'conflict', null) : make('interlock', 'conflict');
  }
  return errorFromResponse(status, body);
}

/** Texto de cualquier error capturado de una acción de control. */
export function controlMessage(e: unknown): string {
  if (e instanceof AdminApiError) return e.message;
  return 'Ocurrió un error inesperado. Probá de nuevo.';
}
