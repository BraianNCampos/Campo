import type { AssetType, OrderCommand, OrderStatus } from '@campo/shared';

/** Comandos y estados de las órdenes (docs/architecture.md §14.3). El CHECK de `orders` (080) repite estas listas. */
export const ORDER_COMMANDS: readonly OrderCommand[] = [
  'fill',
  'drain',
  'stop',
  'start',
  'open',
  'close',
  'set_position',
];
export const ORDER_STATUSES: readonly OrderStatus[] = [
  'pending',
  'accepted',
  'running',
  'done',
  'failed',
  'rejected',
  'timeout',
  'cancelled',
];

/** Estados en los que la orden sigue en curso (ocupa el activo). */
export const OPEN_STATUSES: readonly OrderStatus[] = ['pending', 'accepted', 'running'];
export const isOpen = (s: OrderStatus): boolean => OPEN_STATUSES.includes(s);

/** Comandos admitidos por tipo de activo (§14.3 punto 6). */
export const COMMANDS_BY_TYPE: Partial<Record<AssetType, readonly OrderCommand[]>> = {
  tank: ['fill', 'drain', 'stop'],
  silo: ['fill', 'drain', 'stop'],
  pump: ['start', 'stop'],
  valve: ['open', 'close', 'set_position'],
};

/** Comandos de tanque/silo: llevan `target` (nivel %, 1-99). */
export const LEVEL_COMMANDS: readonly OrderCommand[] = ['fill', 'drain'];

/** Límites y tiempos de la función de control. */
export const CONTROL_LIMITS = {
  /** Validez del `confirmId` (ms). */
  confirmTtlMs: 60_000,
  /** Sin `accepted` en este tiempo la orden pasa a `timeout`. */
  acceptTimeoutMs: 10_000,
  /** Telemetría más vieja que esto = equipo fuera de línea. */
  telemetryMaxAgeMs: 30_000,
  /** Margen (puntos de nivel) por debajo del límite HI. */
  hiMargin: 2,
  /** Órdenes por minuto y usuario (429 al superarlo). Los `stop` no cuentan: ver `stopPerMinute`. */
  ordersPerMinute: 10,
  /** Tope de `stop` (y cancelaciones) por minuto y usuario, sólo para frenar abusos: un paro nunca se bloquea por el límite normal. */
  stopPerMinute: 60,
  rateWindowMs: 60_000,
  /** Valores por defecto de `metadata.control`. */
  defaultMinTarget: 5,
  defaultMaxTarget: 95,
  defaultMaxDurationMinutes: 120,
  /** Rango admitido para `target` de fill/drain. */
  targetMin: 1,
  targetMax: 99,
  /** Cada cuánto se barren los plazos (ms). */
  sweepIntervalMs: 2_000,
} as const;

/** Tópicos MQTT de control (§14.4). */
export const cmdTopic = (plant: string, asset: string): string => `campo/v1/${plant}/${asset}/cmd`;
export const CMD_ACK_FILTER = 'campo/v1/+/+/cmd/ack';
export const CMD_ACK_TOPIC =
  /^campo\/v1\/([a-z0-9][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9_-]{0,63})\/cmd\/ack$/;

/** Canal Redis por el que se difunden los cambios de estado de las órdenes (de ahí lo toma el WebSocket). */
export const ordersChannel = (plant: string): string => `campo:orders:${plant}`;
export const ORDERS_CHANNEL_PREFIX = 'campo:orders:';
