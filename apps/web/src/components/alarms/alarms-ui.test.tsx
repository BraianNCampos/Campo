import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmEvent, AssetDef, Role } from '@campo/shared';
import { emptyBatch } from '@/lib/batcher';
import { clearHistory } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { AlarmsScreen } from './AlarmsScreen';

vi.mock('next/navigation', () => ({ usePathname: () => '/alarmas', useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useLiveStore.getState().reset();
  clearHistory();
  useSessionStore.getState().clear();
  usePlantStore.getState().reset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const def = (id: string, type: AssetDef['type'], name: string): AssetDef => ({ plant: 'demo', id, name, type, model3dRef: null, metadata: {} });
const alarm = (over: Partial<AlarmEvent>): AlarmEvent => ({
  type: 'alarm', id: 'a1', ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level', severity: 'critical', state: 'active', value: 95, threshold: 90, ts: 100, message: 'Nivel alto',
  kind: 'HH', lifecycle: 'unacked', acknowledged: false, ...over,
});

function setup(role: Role, alarms: AlarmEvent[]) {
  useSessionStore.setState({ me: { id: 'u', email: 'u@x.y', role, plants: ['demo'], org: { id: 'o', name: 'O', modules: ['tanks', 'climate'] } }, status: 'ready' });
  usePlantStore.setState({ selected: 'demo' });
  act(() => useLiveStore.getState().setCatalog([def('tk-01', 'tank', 'Tanque 01'), def('tk-02', 'tank', 'Tanque 02'), def('clima-01', 'climate', 'Cámara 1')]));
  const b = emptyBatch();
  b.alarms = alarms;
  act(() => useLiveStore.getState().applyBatch(b));
  act(() => root.render(<AlarmsScreen />));
}
const q = (id: string) => host.querySelectorAll(`[data-testid="${id}"]`);
const rows = () => [...q('alarm-row')].map((r) => r.getAttribute('data-alarm-id'));

const sample = [
  alarm({ id: 'w-old', severity: 'warning', kind: 'HI', ts: 100, asset: 'tk-02' }),
  alarm({ id: 'c-new', severity: 'critical', kind: 'HH', ts: 300 }),
  alarm({ id: 'c-old', severity: 'critical', kind: 'HH', ts: 200, asset: 'clima-01', metric: 'temp', rationale: { description: 'Temperatura muy alta en Cámara 1.' } }),
  alarm({ id: 'rtn', severity: 'warning', kind: 'LO', ts: 50, state: 'cleared', lifecycle: 'rtn_unacked', asset: 'tk-02' }),
  alarm({ id: 'sh', severity: 'warning', kind: 'HI', ts: 60, lifecycle: 'shelved', shelvedUntil: Date.now() + 600_000, shelvedReason: 'mantenimiento' }),
];

describe('Lista de alarmas: permisos por rol', () => {
  it.each([
    ['viewer', false, false],
    ['operator', true, false],
    ['engineer', true, true],
    ['admin', true, true],
  ] as const)('%s: reconocer=%s postergar=%s', (role, ack, shelve) => {
    setup(role, sample);
    expect(q('ack').length > 0).toBe(ack);
    expect(q('ack-all').length > 0).toBe(ack);
    expect(q('shelve').length > 0).toBe(shelve);
    expect(q('open-detail').length).toBeGreaterThan(0); // el detalle lo ve cualquiera
  });
});

describe('Lista de alarmas: contenido', () => {
  it('Activas: orden por prioridad y antigüedad, sin postergadas, con estados de ciclo de vida', () => {
    setup('engineer', sample);
    expect(rows()).toEqual(['c-old', 'c-new', 'rtn', 'w-old']); // críticas (más antigua primero), luego advertencias por antigüedad
    expect(host.querySelector('[data-alarm-id="rtn"] [data-testid="lifecycle"]')?.textContent).toBe('Normalizada sin reconocer');
    expect(host.querySelector('[data-alarm-id="c-new"] [data-testid="lifecycle"]')?.textContent).toBe('Sin reconocer');
    expect(host.querySelector('[data-alarm-id="c-old"] [data-testid="alarm-title"]')?.textContent).toBe('Temperatura muy alta en Cámara 1.');
    expect(host.querySelector('[data-alarm-id="c-new"] [data-testid="alarm-title"]')?.textContent).toBe('Nivel alto'); // sin racionalización: el mensaje
    expect(host.querySelector('[data-testid="count-active"]')?.textContent).toBe('(4)');
    expect(host.querySelector('[data-testid="count-shelved"]')?.textContent).toBe('(1)');
    // «normalizada sin reconocer» se reconoce, pero no se posterga (ya no está activa)
    expect(host.querySelector('[data-alarm-id="rtn"] [data-testid="ack"]')).not.toBeNull();
    expect(host.querySelector('[data-alarm-id="rtn"] [data-testid="shelve"]')).toBeNull();
    expect(host.querySelector('[data-testid="ack-all"]')?.textContent).toMatch(/\(4\)/); // las 4 que faltan reconocer (3 sin reconocer + 1 normalizada)
  });

  it('Postergadas: pestaña propia con su vencimiento y «Reactivar» (no «Reconocer»)', () => {
    setup('engineer', sample);
    act(() => (host.querySelector('[data-testid="tab-shelved"]') as HTMLElement).click());
    expect(rows()).toEqual(['sh']);
    expect(host.querySelector('[data-testid="alarm-time"]')?.textContent).toMatch(/vuelve en \d+ min/);
    expect(host.querySelector('[data-testid="unshelve"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="ack"]')).toBeNull();
  });

  it('estados vacíos con personalidad', () => {
    setup('operator', []);
    expect(host.querySelector('[data-testid="alarms-empty"]')?.textContent).toMatch(/Sin alarmas activas/);
    act(() => (host.querySelector('[data-testid="tab-shelved"]') as HTMLElement).click());
    expect(host.querySelector('[data-testid="alarms-empty"]')?.textContent).toMatch(/No hay nada postergado/);
  });

  it('filtros: módulo, prioridad y búsqueda por activo', () => {
    setup('operator', sample);
    const set = (testid: string, value: string) => {
      const el = host.querySelector(`[data-testid="${testid}"]`) as HTMLSelectElement | HTMLInputElement;
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      act(() => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      });
    };
    set('filter-module', 'climate');
    expect(rows()).toEqual(['c-old']);
    set('filter-module', '');
    set('filter-severity', 'warning');
    expect(rows()).toEqual(['rtn', 'w-old']);
    set('filter-severity', '');
    set('alarm-search', 'tanque 02');
    expect(rows()).toEqual(['rtn', 'w-old']);
    set('alarm-search', 'zzz');
    expect(q('alarms-empty')).toHaveLength(1);
  });
});
