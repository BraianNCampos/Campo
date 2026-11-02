import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetDef, InterlockItem, Limit, ModuleId, Order, OrderPreview, Role } from '@campo/shared';
import { emptyBatch } from '@/lib/batcher';
import { setControlApi } from '@/lib/control';
import { controlErrorFromResponse } from '@/lib/control/errors';
import type { ControlApi } from '@/lib/control/types';
import { clearHistory } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { useOrderStore } from '@/store/order-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { ControlScreen } from './ControlScreen';
import { ConfirmOrderDialog } from './ConfirmOrderDialog';

vi.mock('next/navigation', () => ({ usePathname: () => '/m/control', useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useLiveStore.getState().reset();
  useOrderStore.getState().reset();
  clearHistory();
  useSessionStore.getState().clear();
  usePlantStore.getState().reset();
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setControlApi(null);
  vi.useRealTimers();
});
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const render = (el: React.ReactElement) => act(() => root.render(el));
const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const click = (sel: string) => act(() => q(sel)!.click());

const tank = (id: string, tag: string, control: unknown = { enabled: true, minTarget: 10, maxTarget: 90 }): AssetDef => ({
  plant: 'demo', id, name: `Tanque ${id}`, type: 'tank', model3dRef: null, tag, metadata: { capacityM3: 60, setpoints: { level: 60 }, ...(control ? { control } : {}) },
});
const hh: Limit = { asset: 'tk-01', metric: 'level', operator: 'gt', threshold: 90, severity: 'critical', kind: 'HH' };

function setup(role: Role = 'operator', modules: ModuleId[] = ['tanks', 'control']) {
  act(() => {
    useSessionStore.setState({ me: { id: 'u1', email: 'op@campo.demo', role, plants: ['*'], org: { id: 'c', name: 'C', modules } }, status: 'ready' });
    usePlantStore.setState({ selected: 'demo', plants: [{ id: 'demo', name: 'Planta demo', assets: 3, orgId: 'c' }] });
    useLiveStore.getState().setCatalog([tank('tk-01', 'TNK-101'), tank('tk-02', 'TNK-102'), tank('tk-03', 'TNK-103', { enabled: false })]);
    useLiveStore.getState().setLimits([hh]);
    const b = emptyBatch();
    b.telemetry['tk-01'] = { ts: Date.now(), quality: 'good', values: { level: 50 } };
    b.telemetry['tk-02'] = { ts: Date.now(), quality: 'good', values: { level: 70 } };
    useLiveStore.getState().applyBatch(b);
  });
}

const preview = (over: Partial<OrderPreview> = {}): OrderPreview => ({ confirmId: 'cf-1', expiresAt: Date.now() + 60_000, summary: 'Llenar TNK-101 de 50 % a 80 %.', warnings: ['Si no termina en 120 minutos, se corta sola.'], blocked: null, ...over });
const order = (over: Partial<Order> = {}): Order => ({
  id: 'o1', plant: 'demo', asset: 'tk-01', command: 'fill', target: 80, status: 'pending', requestedBy: { id: 'u1', email: 'op@campo.demo' }, requestedAt: Date.now(), updatedAt: Date.now(), ...over,
});
const fakeApi = (over: Partial<ControlApi> = {}): ControlApi => ({
  preview: vi.fn(async () => preview()),
  execute: vi.fn(async () => order()),
  listOrders: vi.fn(async () => []),
  cancelOrder: vi.fn(async () => order({ status: 'running' })),
  interlocks: vi.fn(async (): Promise<InterlockItem[]> => []),
  setSetpoint: vi.fn(async (_p, _a, metric, value) => ({ metric, value })),
  ...over,
});
const req = { plant: 'demo', asset: 'tk-01', name: 'Tanque tk-01', tag: 'TNK-101', command: 'fill' as const, target: 80 };

describe('diálogo de confirmación (dos pasos)', () => {
  it('abre con la vista previa SIN ejecutar; sólo «Confirmar» ejecuta, con el confirmId', async () => {
    const api = fakeApi();
    setControlApi(api);
    setup();
    render(<ConfirmOrderDialog req={req} onClose={() => {}} />);
    await flush();
    expect(api.preview).toHaveBeenCalledWith('demo', 'tk-01', { command: 'fill', target: 80 });
    expect(api.execute).not.toHaveBeenCalled();
    expect(q('[data-testid="confirm-summary"]')!.textContent).toMatch(/Llenar TNK-101/);
    expect(q('[data-testid="confirm-warnings"]')!.textContent).toMatch(/120 minutos/);
    expect(q('[data-testid="confirm-countdown"]')!.getAttribute('data-seconds')).toBe('60');
    click('[data-testid="confirm-go"]');
    await flush();
    expect(api.execute).toHaveBeenCalledTimes(1);
    expect(api.execute).toHaveBeenCalledWith('demo', 'tk-01', 'cf-1');
    expect(q('[data-testid="confirm-done"]')).not.toBeNull();
    expect(useOrderStore.getState().orders.o1?.status).toBe('pending'); // el registro ya la muestra
  });

  it('un enclavamiento (blocked) se muestra y no deja confirmar', async () => {
    const api = fakeApi({ preview: vi.fn(async () => preview({ blocked: 'Hay una alarma de nivel muy alto (HH) activa.' })) });
    setControlApi(api);
    setup();
    render(<ConfirmOrderDialog req={req} onClose={() => {}} />);
    await flush();
    expect(q('[data-testid="confirm-blocked"]')!.textContent).toMatch(/No se puede dar esta orden.*HH/);
    expect((q('[data-testid="confirm-go"]') as HTMLButtonElement).disabled).toBe(true);
    click('[data-testid="confirm-go"]');
    expect(api.execute).not.toHaveBeenCalled();
  });

  it('la cuenta regresiva llega a 0: vence y obliga a revisar de nuevo', async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const api = fakeApi({ preview: vi.fn(async () => preview({ expiresAt: now + 60_000 })) });
    setControlApi(api);
    setup();
    render(<ConfirmOrderDialog req={req} onClose={() => {}} now={() => now} />);
    await flush();
    now += 30_500;
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(Number(q('[data-testid="confirm-countdown"]')!.getAttribute('data-seconds'))).toBe(30);
    now += 31_000;
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(q('[data-testid="confirm-countdown"]')!.textContent).toMatch(/venció/);
    expect((q('[data-testid="confirm-go"]') as HTMLButtonElement).disabled).toBe(true);
    now = 2_000_000;
    (api.preview as ReturnType<typeof vi.fn>).mockImplementation(async () => preview({ expiresAt: now + 60_000 }));
    click('[data-testid="confirm-reload"]');
    await flush();
    expect(api.preview).toHaveBeenCalledTimes(2);
    expect((q('[data-testid="confirm-go"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('errores 409/429/503 al ejecutar se explican en voseo', async () => {
    for (const [code, status, re] of [['order_in_progress', 409, /Ya hay una orden en curso/], ['rate_limited', 429, /10 por minuto/], ['control_unavailable', 503, /no logra comunicarse/]] as const) {
      const real = controlErrorFromResponse(status, { error: code });
      setControlApi(fakeApi({ execute: vi.fn(async () => { throw real; }) }));
      setup();
      render(<ConfirmOrderDialog key={code} req={req} onClose={() => {}} />);
      await flush();
      click('[data-testid="confirm-go"]');
      await flush();
      expect(q('[data-testid="confirm-error"]')!.textContent).toMatch(re);
    }
  });

  it('detener usa el mismo flujo con botón «Detener ahora»', async () => {
    const api = fakeApi({ preview: vi.fn(async () => preview({ summary: 'Detener TNK-101.', warnings: [] })) });
    setControlApi(api);
    setup();
    render(<ConfirmOrderDialog req={{ ...req, command: 'stop', target: undefined }} onClose={() => {}} />);
    await flush();
    expect(api.preview).toHaveBeenCalledWith('demo', 'tk-01', { command: 'stop' });
    expect(q('[data-testid="confirm-go"]')!.textContent).toMatch(/Detener ahora/);
  });
});

describe('pantalla Control de llenado', () => {
  it('lista los tanques habilitados con tag, nivel y objetivo; avisa de los no habilitados', async () => {
    setControlApi(fakeApi());
    setup();
    render(<ControlScreen />);
    await flush();
    expect(q('[data-testid="control-card-tk-01"]')).not.toBeNull();
    expect(q('[data-testid="control-card-tk-02"]')).not.toBeNull();
    expect(q('[data-testid="control-card-tk-03"]')).toBeNull();
    expect(q('[data-testid="control-tag-tk-01"]')!.textContent).toBe('TNK-101');
    expect(q('[data-testid="control-level-tk-01"]')!.textContent).toBe('50.0');
    expect(q('[data-testid="control-target-tk-01"]')!.textContent).toBe('60'); // el SP, dentro del rango
    expect(q('[data-testid="control-disabled-note"]')!.textContent).toMatch(/1 tanque o silo más no está habilitado/);
  });

  it('un operador ve los botones; llenar abre el diálogo con el objetivo elegido', async () => {
    const api = fakeApi();
    setControlApi(api);
    setup();
    render(<ControlScreen />);
    await flush();
    expect((q('[data-testid="control-fill-tk-01"]') as HTMLButtonElement).disabled).toBe(false);
    expect((q('[data-testid="control-stop-tk-01"]') as HTMLButtonElement).disabled).toBe(false);
    // tk-01 está en 50 %: vaciar a 60 no tiene sentido y se explica por qué
    expect((q('[data-testid="control-drain-tk-01"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-testid="control-reasons-tk-01"]')!.textContent).toMatch(/No se puede vaciar:.*No hace falta vaciar/);
    click('[data-testid="control-fill-tk-01"]');
    await flush();
    expect(api.preview).toHaveBeenCalledWith('demo', 'tk-01', { command: 'fill', target: 60 });
    expect(q('[data-testid="confirm-dialog"]')).not.toBeNull();
    expect(api.execute).not.toHaveBeenCalled();
  });

  it('muestra los permisos de enclavamiento con el motivo de lo que falla; con una alarma HH no se puede llenar pero sí detener', async () => {
    setControlApi(fakeApi());
    setup();
    act(() => {
      const b = emptyBatch();
      b.alarms.push({ type: 'alarm', id: 'a1', ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level', severity: 'critical', state: 'active', value: 92, threshold: 90, ts: Date.now(), message: 'Nivel muy alto', kind: 'HH' });
      useLiveStore.getState().applyBatch(b);
    });
    render(<ControlScreen />);
    await flush();
    expect((q('[data-testid="control-fill-tk-01"]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[data-testid="control-stop-tk-01"]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-testid="control-reasons-tk-01"]')!.textContent).toMatch(/No se puede llenar:.*HH/);
    expect(q('[data-testid="control-interlocks-tk-01"]')!.textContent).toMatch(/\d de \d/);
    expect(q('[data-testid="control-interlocks-tk-01"]')!.textContent).toMatch(/alarma de nivel muy alto \(HH\)/);
  });

  it('el rol de consulta (viewer) sólo lee: sin botones, con el registro visible', async () => {
    setControlApi(fakeApi());
    setup('viewer');
    act(() => useOrderStore.getState().merge([order({ status: 'done', reason: 'Nivel objetivo alcanzado (80 %).' })]));
    render(<ControlScreen />);
    await flush();
    expect(q('[data-testid="control-readonly-tk-01"]')!.textContent).toMatch(/Tu rol es de consulta/);
    expect(q('[data-testid="control-fill-tk-01"]')).toBeNull();
    expect(q('[data-testid="control-stop-tk-01"]')).toBeNull();
    expect(q('[data-testid="order-row"]')).not.toBeNull();
    expect(q('[data-testid="order-cancel"]')).toBeNull();
  });

  it('sin tanques habilitados: estado vacío que dice cómo habilitarlos', async () => {
    setControlApi(fakeApi());
    setup();
    act(() => useLiveStore.getState().setCatalog([tank('tk-01', 'TNK-101', { enabled: false })]));
    render(<ControlScreen />);
    await flush();
    expect(q('[data-testid="control-empty"]')!.textContent).toMatch(/Ningún tanque está habilitado/);
  });
});

describe('registro de órdenes', () => {
  it('muestra estado, quién, resultado y deja cancelar las que siguen en curso (envía un stop)', async () => {
    const api = fakeApi();
    setControlApi(api);
    setup();
    act(() =>
      useOrderStore.getState().merge([
        order({ id: 'o1', status: 'running', requestedAt: Date.now() - 5000 }),
        order({ id: 'o2', status: 'rejected', reason: 'válvula trabada', requestedAt: Date.now() - 60_000, asset: 'tk-02' }),
        order({ id: 'o3', command: 'drain', target: 30, status: 'done', requestedAt: Date.now() - 120_000, reason: 'Nivel objetivo alcanzado (30 %).' }),
      ]),
    );
    render(<ControlScreen />);
    await flush();
    const rows = [...document.body.querySelectorAll('[data-testid="order-row"]')];
    expect(rows.map((r) => r.getAttribute('data-order-id'))).toEqual(['o1', 'o2', 'o3']);
    expect(rows[0]!.textContent).toMatch(/TNK-101/);
    expect(rows[0]!.textContent).toMatch(/Llenar a 80 %/);
    expect(rows[0]!.textContent).toMatch(/En curso/);
    expect(rows[0]!.textContent).toMatch(/op@campo\.demo/);
    expect(rows[1]!.textContent).toMatch(/El equipo la rechazó: válvula trabada/);
    expect(rows[2]!.textContent).toMatch(/Terminada/);
    const cancels = document.body.querySelectorAll('[data-testid="order-cancel"]');
    expect(cancels).toHaveLength(1); // sólo la en curso
    act(() => (cancels[0] as HTMLElement).click());
    await flush();
    expect(api.cancelOrder).toHaveBeenCalledWith('o1');
  });

  it('una orden que llega por WS (evento order) aparece sola', async () => {
    setControlApi(fakeApi());
    setup();
    render(<ControlScreen />);
    await flush();
    expect(q('[data-testid="order-log-empty"]')).not.toBeNull();
    act(() => useOrderStore.getState().upsert(order({ id: 'o9', status: 'pending' })));
    expect(q('[data-order-id="o9"]')).not.toBeNull();
    act(() => useOrderStore.getState().upsert(order({ id: 'o9', status: 'done', updatedAt: Date.now() + 10 })));
    expect(q('[data-order-id="o9"]')!.getAttribute('data-status')).toBe('done');
  });

  it('avisa cuando no se pudo cargar el registro', async () => {
    setControlApi(fakeApi());
    setup();
    act(() => useOrderStore.getState().setError(true));
    render(<ControlScreen />);
    await flush();
    expect(q('[data-testid="order-log-error"]')!.textContent).toMatch(/No pudimos cargar el registro/);
  });
});
