import type { Order, OrderCommand, OrderStatus } from '@campo/shared';
import { CONFIRM_TTL_MS, ACTIVE_STATUSES } from './types';

/** Textos y cálculos puros del flujo de órdenes (confirmación de dos pasos, registro). */

export const COMMAND_LABEL: Record<OrderCommand, string> = {
  fill: 'Llenar',
  drain: 'Vaciar',
  stop: 'Detener',
  start: 'Arrancar',
  open: 'Abrir',
  close: 'Cerrar',
  set_position: 'Posicionar',
};

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'Pendiente',
  accepted: 'Aceptada por el equipo',
  running: 'En curso',
  done: 'Terminada',
  failed: 'Falló',
  rejected: 'Rechazada por el equipo',
  timeout: 'Sin respuesta',
  cancelled: 'Cancelada',
};

export type StatusTone = 'progress' | 'ok' | 'bad' | 'neutral';
export const STATUS_TONE: Record<OrderStatus, StatusTone> = {
  pending: 'progress',
  accepted: 'progress',
  running: 'progress',
  done: 'ok',
  failed: 'bad',
  rejected: 'bad',
  timeout: 'bad',
  cancelled: 'neutral',
};

export const isFinalStatus = (s: OrderStatus): boolean => !ACTIVE_STATUSES.includes(s);

const fmtPct = (n: number) => `${String(Math.round(n * 10) / 10).replace('.', ',')} %`;

/** «Llenar a 80 %», «Detener». */
export function orderText(o: Pick<Order, 'command' | 'target'>): string {
  const base = COMMAND_LABEL[o.command] ?? o.command;
  return o.target !== undefined ? `${base} a ${fmtPct(o.target)}` : base;
}

/** Qué le pasó a la orden, en una frase (motivo del servidor si lo hay). */
export function outcomeText(o: Pick<Order, 'status' | 'reason'>): string {
  const why = o.reason?.trim();
  switch (o.status) {
    case 'pending': return 'Esperando que el equipo la acepte.';
    case 'accepted': return 'El equipo la aceptó y está por empezar.';
    case 'running': return 'El equipo la está ejecutando.';
    case 'done': return why ?? 'Se completó.';
    case 'failed': return why ? `Falló: ${why}` : 'El equipo informó una falla.';
    case 'rejected': return why ? `El equipo la rechazó: ${why}` : 'El equipo la rechazó.';
    case 'timeout': return why ?? 'El equipo no respondió a tiempo.';
    case 'cancelled': return why ?? 'Se canceló con una orden de detención.';
  }
}

/** Una orden se puede cancelar mientras sigue en curso (cancelar envía un `stop`). */
export const isCancellable = (o: Pick<Order, 'status' | 'command'>): boolean => ACTIVE_STATUSES.includes(o.status) && o.command !== 'stop';

export interface Countdown {
  /** segundos que faltan, redondeados hacia arriba */
  seconds: number;
  /** fracción restante 0–1 */
  fraction: number;
  expired: boolean;
}

/** Cuenta regresiva de una confirmación (`expiresAt` en epoch ms; vigencia total `ttlMs`, 60 s por contrato). */
export function countdown(expiresAt: number, now: number, ttlMs: number = CONFIRM_TTL_MS): Countdown {
  const left = expiresAt - now;
  if (left <= 0) return { seconds: 0, fraction: 0, expired: true };
  return { seconds: Math.ceil(left / 1000), fraction: Math.min(1, left / ttlMs), expired: false };
}

/** «hace 5 s», «hace 3 min», «hace 2 h», «hace 4 d». */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

/** Ordena por pedido: lo más reciente primero. */
export const sortOrders = <T extends Pick<Order, 'requestedAt' | 'id'>>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => b.requestedAt - a.requestedAt || b.id.localeCompare(a.id));
