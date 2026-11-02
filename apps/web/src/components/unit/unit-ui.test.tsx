import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmEvent, InterlockItem, Limit, ModuleId, Role } from '@campo/shared';
import { emptyBatch } from '@/lib/batcher';
import { DEMO_ASSETS } from '@/lib/demo-seed';
import { setControlApi } from '@/lib/control';
import type { ControlApi } from '@/lib/control/types';
import { clearHistory } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { EquipmentScreen } from './EquipmentScreen';
import { UnitScreen } from './UnitScreen';

vi.mock('next/navigation', () => ({ usePathname: () => '/m/tanks/tnk-101', useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useLiveStore.getState().reset();
  clearHistory();
  useSessionStore.getState().clear();
  usePlantStore.getState().reset();
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setControlApi(null);
  vi.restoreAllMocks();
});
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const render = (el: React.ReactElement) => act(() => root.render(el));
const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';
const change = (sel: string, value: string) =>
  act(() => {
    const el = q(sel) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

const demo = DEMO_ASSETS.demo!;
const lim = (asset: string, metric: string, operator: Limit['operator'], threshold: number, severity: Limit['severity'] = 'warning'): Limit => ({ asset, metric, operator, threshold, severity });

function setup(role: Role = 'operator', modules: ModuleId[] = ['tanks', 'machines', 'control']) {
  act(() => {
    useSessionStore.setState({ me: { id: 'u1', email: 'op@campo.demo', role, plants: ['*'], org: { id: 'c', name: 'C', modules } }, status: 'ready' });
    usePlantStore.setState({ selected: 'demo', plants: [{ id: 'demo', name: 'Planta demo', assets: demo.length, orgId: 'c' }] });
    const s = useLiveStore.getState();
    s.setMode('mock', 'demo');
    s.setCatalog(demo);
    s.setLimits([lim('tk-01', 'level', 'gt', 90, 'critical'), lim('tk-01', 'level', 'lt', 10)]);
    const b = emptyBatch();
    const ts = Date.now();
    b.telemetry['tk-01'] = { ts, quality: 'good', values: { level: 72, temp: 19, sts: 1, mode: 1 } };
    b.telemetry['valve-01'] = { ts, quality: 'good', values: { position: 85 } };
    b.telemetry['pump-01'] = { ts, quality: 'good', values: { rpm: 1450, current: 11.2, hours: 3412.4 } };
    b.telemetry['maq-01'] = { ts, quality: 'good', values: { state: 1, hours: 1500 } };
    useLiveStore.getState().applyBatch(b);
  });
}

const fakeApi = (over: Partial<ControlApi> = {}): ControlApi => ({
  preview: vi.fn(), execute: vi.fn(), listOrders: vi.fn(async () => []), cancelOrder: vi.fn(),
  interlocks: vi.fn(async (): Promise<InterlockItem[]> => [
    { id: 'role', label: 'Tu rol puede dar órdenes', ok: true },
    { id: 'telemetry', label: 'El equipo informa datos recientes', ok: false, reason: 'El equipo no informa datos hace 45 segundos.' },
  ]),
  setSetpoint: vi.fn(async (_p, _a, metric, value) => ({ metric, value })),
  ...over,
});

describe('nivel 3: detalle de la unidad (/m/<módulo>/<tag>)', () => {
  it('el tag en minúsculas resuelve el activo; muestra tag, PV/SP/OP/MODE/STS y la barra de desviación', () => {
    setup();
    render(<UnitScreen module="tanks" tag="tnk-101" />);
    expect(text('[data-testid="unit-name"]')).toBe('Tanque 01');
    expect(text('[data-testid="unit-tag"]')).toBe('TNK-101');
    expect(text('[data-testid="fp-pv"]')).toMatch(/72,?\.?0?/);
    expect(text('[data-testid="fp-pv"]')).toMatch(/72\.0/);
    expect(text('[data-testid="fp-sp"]')).toMatch(/60\.0/);
    expect(text('[data-testid="fp-op"]')).toMatch(/85/); // apertura de la válvula asociada
    expect(text('[data-testid="fp-mode"]')).toMatch(/Automático/);
    expect(text('[data-testid="fp-sts"]')).toMatch(/Llenando/);
    expect(q('[data-testid="fp-bar"] [data-testid="deviation-bar"]')).not.toBeNull();
  });

  it('muestra las válvulas y bombas asociadas y las alarmas del equipo con tag, descripción, valor y límite', () => {
    setup();
    act(() => {
      const b = emptyBatch();
      const a: AlarmEvent = { type: 'alarm', id: 'a1', ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level', severity: 'critical', state: 'active', value: 91.5, threshold: 90, ts: Date.now(), message: 'Nivel muy alto', kind: 'HH', rationale: { description: 'Nivel muy alto en el tanque.' } };
      b.alarms.push(a);
      useLiveStore.getState().applyBatch(b);
    });
    render(<UnitScreen module="tanks" tag="tnk-101" />);
    expect(q('[data-testid="related-valve-01"]')).not.toBeNull();
    expect(text('[data-testid="related-value-valve-01"]')).toMatch(/85 %/);
    expect(q('[data-testid="related-pump-01"]')).not.toBeNull();
    expect(q('[data-testid="related-tk-02"]')).toBeNull();
    const row = q('[data-testid="unit-alarms"] [data-testid="alarm-row"]')!;
    expect(row.textContent).toMatch(/TNK-101/);
    expect(row.textContent).toMatch(/Nivel muy alto en el tanque/);
    expect(row.textContent).toMatch(/91\.5 %/);
    expect(row.textContent).toMatch(/> 90 %/);
  });

  it('sin alarmas ni asociados lo dice; un operador ve el enlace al nivel 4 y un viewer no', () => {
    setup('operator');
    render(<UnitScreen module="machines" tag="mtr-101" />);
    expect(q('[data-testid="related-empty"]')).not.toBeNull();
    expect(q('[data-testid="unit-alarms-empty"]')).not.toBeNull();
    expect(q('[data-testid="unit-equipment-link"]')!.getAttribute('href')).toBe('/m/machines/mtr-101/equipo');
    expect(q('[data-testid="unit-back"]')!.getAttribute('href')).toBe('/m/machines');
    act(() => root.unmount());
    root = createRoot(host);
    setup('viewer');
    render(<UnitScreen module="machines" tag="mtr-101" />);
    expect(q('[data-testid="unit-equipment-link"]')).toBeNull();
  });

  it('tag inexistente, módulo equivocado o sin catálogo todavía', () => {
    setup();
    render(<UnitScreen module="tanks" tag="tnk-999" />);
    expect(q('[data-testid="unit-notfound"]')).not.toBeNull();
    render(<UnitScreen module="machines" tag="tnk-101" />); // existe, pero es del módulo tanks
    expect(q('[data-testid="unit-notfound"]')).not.toBeNull();
    act(() => useLiveStore.getState().reset());
    render(<UnitScreen module="tanks" tag="tnk-101" />);
    expect(q('[data-testid="unit-loading"]')).not.toBeNull();
  });

  it('módulo no contratado', () => {
    setup('operator', ['machines']);
    render(<UnitScreen module="tanks" tag="tnk-101" />);
    expect(q('[data-testid="module-not-contracted"]')).not.toBeNull();
  });
});

describe('nivel 4: detalle del equipo (/m/<módulo>/<tag>/equipo)', () => {
  it('panel de motor: STS, rpm, corriente y horas', async () => {
    setControlApi(fakeApi({ interlocks: vi.fn(async () => []) }));
    setup();
    render(<EquipmentScreen module="tanks" tag="pmp-101" />);
    await flush();
    expect(text('[data-testid="motor-sts"]')).toMatch(/En marcha/);
    expect(text('[data-testid="motor-rpm"]')).toMatch(/1\s?450/);
    expect(text('[data-testid="motor-current"]')).toMatch(/11\.2/);
    expect(text('[data-testid="motor-hours"]')).toMatch(/3\s?412\.4/);
    expect(text('[data-testid="interlock-empty"]')).toMatch(/no recibe órdenes/);
    expect(q('[data-testid="setpoint-panel"]')).toBeNull(); // las bombas no tienen setpoint
  });

  it('permisos de enclavamiento desde la API, con el motivo de lo que falla', async () => {
    const api = fakeApi();
    setControlApi(api);
    setup();
    render(<EquipmentScreen module="tanks" tag="tnk-101" />);
    await flush();
    expect(api.interlocks).toHaveBeenCalledWith('demo', 'tk-01');
    expect(text('[data-testid="interlock-summary"]')).toMatch(/1 de 2/);
    expect(text('[data-testid="interlock-telemetry"]')).toMatch(/45 segundos/);
    expect(q('[data-testid="interlock-role"]')!.getAttribute('data-ok')).toBe('true');
  });

  it('un viewer no entra al nivel 4', async () => {
    setControlApi(fakeApi());
    setup('viewer');
    render(<EquipmentScreen module="tanks" tag="tnk-101" />);
    await flush();
    expect(q('[data-testid="equipment-forbidden"]')).not.toBeNull();
    expect(q('[data-testid="motor-panel"]')).toBeNull();
  });

  it('operator ve el setpoint sin poder cambiarlo', async () => {
    setControlApi(fakeApi());
    setup('operator');
    render(<EquipmentScreen module="tanks" tag="tnk-101" />);
    await flush();
    expect(text('[data-testid="setpoint-current"]')).toMatch(/60\.0 %/);
    expect(q('[data-testid="setpoint-readonly"]')).not.toBeNull();
    expect(q('[data-testid="setpoint-input"]')).toBeNull();
  });

  it('engineer: valida contra la escala, confirma y guarda con PUT; el catálogo se actualiza', async () => {
    const api = fakeApi();
    setControlApi(api);
    setup('engineer');
    render(<EquipmentScreen module="tanks" tag="tnk-101" />);
    await flush();
    change('[data-testid="setpoint-input"]', '150');
    act(() => q('[data-testid="setpoint-save"]')!.click());
    expect(document.body.textContent).toMatch(/dentro de la escala de la métrica \(de 0 a 100\)/);
    expect(api.setSetpoint).not.toHaveBeenCalled();
    change('[data-testid="setpoint-input"]', '65');
    act(() => q('[data-testid="setpoint-save"]')!.click());
    // diálogo de confirmación: no se guarda hasta confirmar
    expect(api.setSetpoint).not.toHaveBeenCalled();
    const confirm = [...document.body.querySelectorAll('button')].find((b) => /Cambiar setpoint/.test(b.textContent ?? ''))!;
    await act(async () => { confirm.click(); });
    await flush();
    expect(api.setSetpoint).toHaveBeenCalledWith('demo', 'tk-01', 'level', 65);
    expect((useLiveStore.getState().catalog['tk-01']!.metadata as { setpoints: Record<string, number> }).setpoints.level).toBe(65);
    expect(text('[data-testid="setpoint-current"]')).toMatch(/65\.0 %/);
  });
});

