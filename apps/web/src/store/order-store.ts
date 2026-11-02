/**
 * Registro de órdenes en vivo (docs/architecture.md §14.3): lo cargan `GET /api/plants/:plant/orders` al (re)conectar y los
 * eventos WS `{type:"order"}`; cada orden se actualiza por `id` (el estado más reciente gana).
 */
import { create } from 'zustand';
import type { Order } from '@campo/shared';
import { isActiveOrder } from '@/lib/control/types';
import { sortOrders } from '@/lib/control/flow';

export const MAX_ORDERS = 200;

export interface OrderData {
  orders: Record<string, Order>;
  /** el registro ya se cargó al menos una vez */
  ready: boolean;
  /** la última carga falló (el registro puede estar incompleto) */
  error: boolean;
}

export interface OrderActions {
  /** Mezcla una lista cargada del servidor con lo que ya llegó por WS. */
  merge(list: readonly Order[]): void;
  upsert(order: Order): void;
  setError(failed: boolean): void;
  reset(): void;
}

export const initialOrderData = (): OrderData => ({ orders: {}, ready: false, error: false });

/** Una orden con `updatedAt` menor que la guardada es vieja (fuera de orden) y se ignora. */
function put(orders: Record<string, Order>, o: Order): void {
  const prev = orders[o.id];
  if (prev && o.updatedAt < prev.updatedAt) return;
  orders[o.id] = prev ? { ...prev, ...o } : o;
}

function prune(orders: Record<string, Order>): void {
  const ids = Object.keys(orders);
  if (ids.length <= MAX_ORDERS) return;
  ids
    .filter((id) => !isActiveOrder(orders[id]!))
    .sort((a, b) => orders[a]!.requestedAt - orders[b]!.requestedAt)
    .slice(0, ids.length - MAX_ORDERS)
    .forEach((id) => delete orders[id]);
}

export const useOrderStore = create<OrderData & OrderActions>()((set, get) => ({
  ...initialOrderData(),
  merge(list) {
    const orders = { ...get().orders };
    for (const o of list) put(orders, o);
    prune(orders);
    set({ orders, ready: true, error: false });
  },
  upsert(order) {
    const orders = { ...get().orders };
    put(orders, order);
    prune(orders);
    set({ orders });
  },
  setError(error) {
    if (get().error !== error) set({ error });
  },
  reset() {
    set(initialOrderData());
  },
}));

// ---- Selectores (memoizados por la identidad del mapa) ----
function memo<T>(compute: (orders: Record<string, Order>) => T): (s: Pick<OrderData, 'orders'>) => T {
  const cache = new WeakMap<object, T>();
  return (s) => {
    let v = cache.get(s.orders);
    if (v === undefined) {
      v = compute(s.orders);
      cache.set(s.orders, v);
    }
    return v;
  };
}

/** Todas las órdenes, las más recientes primero. */
export const selectOrders = memo((orders) => sortOrders(Object.values(orders)));

/** Orden en curso por activo (la más reciente si hubiera más de una). */
export const selectActiveByAsset = memo((orders) => {
  const out: Record<string, Order> = {};
  for (const o of sortOrders(Object.values(orders))) if (isActiveOrder(o) && !out[o.asset]) out[o.asset] = o;
  return out;
});
