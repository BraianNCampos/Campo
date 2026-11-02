import type { InterlockItem, Order, OrderCommand, OrderPreview, OrderStatus } from '@campo/shared';

/**
 * Cliente de control (docs/architecture.md §14.3). Dos implementaciones: HTTP (la API real) y un mock en el cliente
 * (modo demo, sin backend) que replica la confirmación en dos pasos, los enclavamientos y el ciclo de vida de las órdenes.
 */

export interface PreviewRequest {
  command: OrderCommand;
  /** nivel objetivo en % (1–99); sólo para llenar/vaciar */
  target?: number;
}

export interface OrderQuery {
  asset?: string;
  status?: OrderStatus;
  limit?: number;
  before?: string;
}

export interface SetpointResult {
  metric: string;
  value: number;
}

export interface ControlApi {
  /** Paso 1: `POST /api/plants/:plant/assets/:asset/commands/preview`. Nada se ejecuta. */
  preview(plant: string, asset: string, req: PreviewRequest): Promise<OrderPreview>;
  /** Paso 2: `POST /api/plants/:plant/assets/:asset/commands {confirmId}`. El `confirmId` es de un solo uso. */
  execute(plant: string, asset: string, confirmId: string): Promise<Order>;
  /** Registro de órdenes: `GET /api/plants/:plant/orders`. */
  listOrders(plant: string, q?: OrderQuery): Promise<Order[]>;
  /** `POST /api/orders/:id/cancel`: envía un `stop`. */
  cancelOrder(orderId: string): Promise<Order>;
  /** Permisos de enclavamiento del equipo: `GET /api/plants/:plant/assets/:asset/interlocks`. */
  interlocks(plant: string, asset: string): Promise<InterlockItem[]>;
  /** `PUT /api/plants/:plant/assets/:asset/setpoints/:metric {value}` (engineer+). */
  setSetpoint(plant: string, asset: string, metric: string, value: number): Promise<SetpointResult>;
}

/** Valores por defecto de `metadata.control` (§14.3). */
export const CONTROL_DEFAULTS = { minTarget: 5, maxTarget: 95, maxDurationMinutes: 120 } as const;

/** Margen (puntos de nivel) por debajo del límite alto del nivel para el objetivo máximo (§14.3). */
export const HI_MARGIN = 2;

/** Vigencia de una confirmación (§14.3: 60 s). */
export const CONFIRM_TTL_MS = 60_000;

/** Un equipo sin telemetría desde hace más de esto no recibe órdenes (§14.3: 30 s). */
export const STALE_TELEMETRY_MS = 30_000;

/** Estados en que una orden sigue en curso. */
export const ACTIVE_STATUSES: readonly OrderStatus[] = ['pending', 'accepted', 'running'];
export const isActiveOrder = (o: Pick<Order, 'status'>): boolean => ACTIVE_STATUSES.includes(o.status);
