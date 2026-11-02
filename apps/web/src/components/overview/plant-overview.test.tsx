import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmEvent, AssetDef, Limit, ModuleId } from '@campo/shared';
import { emptyBatch } from '@/lib/batcher';
import { clearHistory } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { PlantOverview } from './PlantOverview';

const replace = vi.fn();
let mobile = false;
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }), usePathname: () => '/' }));
vi.mock('../hooks', async (orig) => ({ ...(await orig<typeof import('../hooks')>()), useIsMobile: () => mobile }));
vi.mock('../PlantView', () => ({ PlantView: () => <div data-testid="scene-stub" /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  replace.mockClear();
  mobile = false;
  useLiveStore.getState().reset();
  usePlantStore.getState().reset();
  useSessionStore.getState().clear();
  clearHistory();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const def = (id: string, type: AssetDef['type']): AssetDef => ({ plant: 'demo', id, name: id, type, model3dRef: null, metadata: {} });
const login = (modules: ModuleId[]) =>
  act(() => useSessionStore.setState({ me: { id: 'u', email: 'a@b.c', role: 'admin', plants: ['*'], org: { id: 'c', name: 'Cliente', modules } }, status: 'ready' }));
const alarm = (over: Partial<AlarmEvent>): AlarmEvent => ({
  type: 'alarm', id: 'a1', ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level', severity: 'critical', state: 'active', value: 95, threshold: 90, ts: 100, message: '', ...over,
});
const lim = (asset: string, threshold: number): Limit => ({ asset, metric: 'level', operator: 'gt', threshold, severity: 'critical' });
const seed = () =>
  act(() => {
    const s = useLiveStore.getState();
    s.setCatalog([def('tk-01', 'tank'), def('tk-02', 'tank'), def('clima-01', 'climate')]);
    s.setLimits([lim('tk-01', 90), lim('tk-02', 90)]);
    const b = emptyBatch();
    b.telemetry['tk-01'] = { ts: 1, quality: 'good', values: { level: 95 } };
    b.telemetry['tk-02'] = { ts: 1, quality: 'good', values: { level: 40 } };
    b.telemetry['clima-01'] = { ts: 1, quality: 'good', values: { temp: 20, humidity: 50 } };
    b.alarms = [
      alarm({ id: 'a1', lifecycle: 'unacked' }),
      alarm({ id: 'a2', asset: 'tk-02', severity: 'warning', state: 'cleared', lifecycle: 'rtn_unacked' }),
      alarm({ id: 'a3', asset: 'clima-01', severity: 'warning', lifecycle: 'shelved', shelvedUntil: 9e12 }),
    ];
    s.applyBatch(b);
  });
const render = () => {
  act(() => root.render(<PlantOverview />));
  act(() => void vi.advanceTimersByTime(1100)); // los derivados se refrescan ≤1 Hz
};
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('vista general de la planta', () => {
  it('un cliente con un solo módulo va directo a su pantalla', () => {
    login(['tanks']);
    render();
    expect(replace).toHaveBeenCalledWith('/m/tanks');
    expect(q('plant-overview')).toBeNull();
  });
  it('sin módulos: aviso claro, sin redirigir', () => {
    login([]);
    render();
    expect(replace).not.toHaveBeenCalled();
    expect(q('no-modules')).not.toBeNull();
  });
  it('sin view3d: mapa 2D con una tarjeta por módulo (sin «Vista 3D») y salud de alarmas', () => {
    login(['tanks', 'climate']);
    seed();
    render();
    expect(q('plant-overview')?.getAttribute('data-mode')).toBe('map');
    expect(replace).not.toHaveBeenCalled();
    expect(q('overview-module-tanks')?.getAttribute('href')).toBe('/m/tanks');
    expect(q('overview-module-tanks')?.getAttribute('data-status')).toBe('alarm');
    expect(q('overview-attention-tanks')?.textContent).toBe('1 de 2 requiere atención');
    expect(q('overview-module-climate')?.getAttribute('data-status')).toBe('ok');
    expect(q('health-unacked')?.getAttribute('data-count')).toBe('1');
    expect(q('health-rtn')?.getAttribute('data-count')).toBe('1');
    expect(q('health-shelved')?.getAttribute('data-count')).toBe('1');
    expect(q('health-critical')?.getAttribute('data-count')).toBe('1');
    expect(q('scene-stub')).toBeNull();
  });
  it('sin valores de instrumentos en pantalla', () => {
    login(['tanks', 'climate']);
    seed();
    render();
    const text = q('plant-overview')!.textContent!;
    expect(text).not.toMatch(/95|40|20 °C/);
  });
  it('con view3d en escritorio: escena central con paneles de vidrio', () => {
    login(['tanks', 'climate', 'view3d']);
    seed();
    render();
    expect(q('plant-overview')?.getAttribute('data-mode')).toBe('scene');
    expect(q('scene-stub')).not.toBeNull();
    expect(host.querySelectorAll('.glass').length).toBeGreaterThanOrEqual(2);
    expect(q('overview-module-view3d')).toBeNull();
  });
  it('en móvil el 3D es opt-in', () => {
    mobile = true;
    login(['tanks', 'view3d']);
    seed();
    render();
    expect(q('scene-stub')).toBeNull();
    act(() => (q('overview-3d-open') as HTMLElement).click());
    expect(q('scene-stub')).not.toBeNull();
  });
  it('muestra la conexión y la latencia', () => {
    login(['tanks', 'climate']);
    seed();
    act(() => useLiveStore.setState({ latencyMs: 85 }));
    render();
    expect(q('overview-latency')?.textContent).toBe('85 ms');
    expect(q('connection-chip')).not.toBeNull();
  });
});
