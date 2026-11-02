import { beforeEach, describe, expect, it } from 'vitest';
import type { Order } from '@campo/shared';
import { MAX_ORDERS, selectActiveByAsset, selectOrders, useOrderStore } from './order-store';

const ord = (id: string, over: Partial<Order> = {}): Order => ({
  id, plant: 'demo', asset: 'tk-01', command: 'fill', target: 80, status: 'pending', requestedBy: { id: 'u', email: 'op@campo.demo' }, requestedAt: 1000, updatedAt: 1000, ...over,
});

beforeEach(() => useOrderStore.getState().reset());

describe('order-store', () => {
  it('upsert por id: el estado más reciente gana; un evento viejo se ignora', () => {
    const s = useOrderStore.getState();
    s.upsert(ord('o1'));
    s.upsert(ord('o1', { status: 'running', updatedAt: 2000 }));
    s.upsert(ord('o1', { status: 'accepted', updatedAt: 1500 })); // fuera de orden
    expect(useOrderStore.getState().orders.o1!.status).toBe('running');
  });
  it('merge de la lista REST con lo que ya llegó por WS marca el registro como cargado', () => {
    const s = useOrderStore.getState();
    s.upsert(ord('o2', { status: 'done', updatedAt: 3000 }));
    s.merge([ord('o1'), ord('o2', { status: 'running', updatedAt: 2000 })]);
    const st = useOrderStore.getState();
    expect(st.ready).toBe(true);
    expect(Object.keys(st.orders).sort()).toEqual(['o1', 'o2']);
    expect(st.orders.o2!.status).toBe('done'); // lo más nuevo se conserva
  });
  it('selectores: lista por pedido (reciente primero) y orden en curso por activo', () => {
    const s = useOrderStore.getState();
    s.merge([
      ord('a', { requestedAt: 1 }),
      ord('b', { requestedAt: 3, asset: 'tk-02', status: 'running' }),
      ord('c', { requestedAt: 2, status: 'done' }),
    ]);
    const st = useOrderStore.getState();
    expect(selectOrders(st).map((o) => o.id)).toEqual(['b', 'c', 'a']);
    expect(Object.keys(selectActiveByAsset(st)).sort()).toEqual(['tk-01', 'tk-02']);
    expect(selectActiveByAsset(st)['tk-01']!.id).toBe('a');
    expect(selectOrders(st)).toBe(selectOrders(st)); // memoizado
  });
  it('conserva como mucho MAX_ORDERS sin perder las que siguen en curso', () => {
    const list = Array.from({ length: MAX_ORDERS + 20 }, (_, i) => ord(`o${i}`, { requestedAt: i, status: i === 0 ? 'running' : 'done' }));
    useOrderStore.getState().merge(list);
    const st = useOrderStore.getState();
    expect(Object.keys(st.orders).length).toBe(MAX_ORDERS);
    expect(st.orders.o0).toBeDefined();
  });
  it('error y reset', () => {
    useOrderStore.getState().setError(true);
    expect(useOrderStore.getState().error).toBe(true);
    useOrderStore.getState().reset();
    expect(useOrderStore.getState()).toMatchObject({ error: false, ready: false, orders: {} });
  });
});
