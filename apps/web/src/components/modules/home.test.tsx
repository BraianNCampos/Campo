import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyBatch } from '@/lib/batcher';
import { useLiveStore } from '@/store/live-store';
import { useSessionStore } from '@/store/session-store';
import { createThrottledDerived } from './derived';
import { HomeRedirect } from './HomeRedirect';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }), usePathname: () => '/' }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  replace.mockClear();
  useLiveStore.getState().reset();
  useSessionStore.getState().clear();
});
afterEach(() => vi.useRealTimers());

function mount(el: React.ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, done: () => { act(() => root.unmount()); host.remove(); } };
}
const org = (modules: string[]) => ({ id: 'c', name: 'C', modules: modules as never });
const login = (o: ReturnType<typeof org> | null, role: 'admin' | 'platform_admin' = 'admin') =>
  act(() => useSessionStore.setState({ me: { id: 'u', email: 'a@b.c', role, plants: ['*'], org: o }, status: 'ready' }));

describe('«/»', () => {
  it('redirige al primer módulo activo', () => {
    login(org(['energy', 'tanks']));
    const m = mount(<HomeRedirect />);
    expect(replace).toHaveBeenCalledWith('/m/tanks');
    m.done();
  });
  it('sin módulos contratados: estado claro con el contacto a Campos Ingeniería, sin redirigir', () => {
    login(org([]));
    const m = mount(<HomeRedirect />);
    expect(replace).not.toHaveBeenCalled();
    expect(m.host.querySelector('[data-testid="no-modules"]')?.textContent).toContain('Sin módulos contratados');
    expect(m.host.textContent).toContain('Contactá a Campos Ingeniería');
    m.done();
  });
  it('cliente solo tanques → /m/tanks', () => {
    login(org(['tanks']));
    const m = mount(<HomeRedirect />);
    expect(replace).toHaveBeenCalledWith('/m/tanks');
    m.done();
  });
});

describe('derivados limitados en frecuencia (sin re-render por mensaje)', () => {
  it('muchos mensajes dentro del intervalo notifican una sola vez, y sólo si el valor cambió', () => {
    vi.useFakeTimers();
    const d = createThrottledDerived((s) => Object.keys(s.assets).length, (a, b) => a === b, 1000);
    const listener = vi.fn();
    const off = d.subscribe(listener);
    for (let i = 0; i < 50; i++) {
      const b = emptyBatch();
      b.telemetry[`a${i}`] = { ts: 1, quality: 'good', values: { x: i } };
      useLiveStore.getState().applyBatch(b);
    }
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(d.getSnapshot()).toBe(50);
    const b = emptyBatch();
    b.telemetry.a0 = { ts: 5, quality: 'good', values: { x: 99 } }; // mismo nº de activos → sin notificación
    useLiveStore.getState().applyBatch(b);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
