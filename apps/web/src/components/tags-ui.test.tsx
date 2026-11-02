import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmEvent, AssetDef } from '@campo/shared';
import { emptyBatch } from '@/lib/batcher';
import { clearHistory } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { useSessionStore } from '@/store/session-store';
import { usePlantStore } from '@/store/plant-store';
import { AlarmList } from './AlarmList';
import { AssetCard } from './AssetCard';
import { ModuleCard } from './modules/ModuleCard';
import { AlarmFooter } from './shell/AlarmFooter';

vi.mock('next/navigation', () => ({ usePathname: () => '/m/tanks', useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
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

const defs: AssetDef[] = [
  { plant: 'demo', id: 'tk-01', name: 'Tanque Norte', type: 'tank', model3dRef: null, tag: 'TNK-101', metadata: {} },
  { plant: 'demo', id: 'silo-01', name: 'Silo 1', type: 'silo', model3dRef: null, tag: 'TNK-301', metadata: {} },
  { plant: 'demo', id: 'nave-01', name: 'Nave', type: 'structure', model3dRef: null, metadata: {} },
];
const alarm: AlarmEvent = { type: 'alarm', id: 'a1', ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level', severity: 'critical', state: 'active', value: 95, threshold: 90, ts: 1, message: 'Nivel alto', kind: 'HH' };

function load() {
  act(() => {
    useLiveStore.getState().setCatalog(defs);
    const b = emptyBatch();
    b.telemetry['tk-01'] = { ts: 1, quality: 'good', values: { level: 95 } };
    b.telemetry['silo-01'] = { ts: 1, quality: 'good', values: { level: 40, temp: 20 } };
    b.alarms.push(alarm);
    useLiveStore.getState().applyBatch(b);
  });
}
const text = (sel: string) => host.querySelector(sel)?.textContent ?? '';

describe('el tag junto al nombre en toda la interfaz (monoespaciado)', () => {
  it('tarjeta de módulo: nombre y tag, con enlace al detalle de la unidad', () => {
    load();
    act(() => root.render(<ModuleCard id="tk-01" />));
    expect(text('[data-testid="tag-tk-01"]')).toBe('TNK-101');
    expect(host.querySelector('[data-testid="tag-tk-01"]')!.className).toMatch(/font-mono/);
    expect(host.querySelector('[data-testid="unit-link-tk-01"]')!.getAttribute('href')).toBe('/m/tanks/tnk-101');
  });
  it('un silo se trata como tanque (nivel) y enlaza al módulo tanks; sin tag se muestra el id', () => {
    load();
    act(() => root.render(<><ModuleCard id="silo-01" /><ModuleCard id="nave-01" /></>));
    expect(text('[data-testid="tag-silo-01"]')).toBe('TNK-301');
    expect(host.querySelector('[data-testid="unit-link-silo-01"]')!.getAttribute('href')).toBe('/m/tanks/tnk-301');
    expect(text('[data-testid="value-silo-01"]')).toBe('40.0');
    expect(text('[data-testid="tag-nave-01"]')).toBe('nave-01');
    expect(host.querySelector('[data-testid="unit-link-nave-01"]')).toBeNull(); // las estructuras no tienen detalle
  });
  it('tarjeta móvil y lista de alarmas', () => {
    load();
    act(() => root.render(<><AssetCard id="tk-01" /><AlarmList /></>));
    expect(text('[data-testid="tag-tk-01"]')).toBe('TNK-101');
    expect(text('[data-testid="alarm-item"]')).toMatch(/TNK-101/);
  });
  it('pie global de alarmas: tag, valor y límite', () => {
    load();
    act(() => root.render(<AlarmFooter />));
    expect(text('[data-testid="footer-alarm-tag"]')).toBe('TNK-101');
    expect(text('[data-testid="footer-alarm"]')).toMatch(/95\.0 %/);
    expect(text('[data-testid="footer-alarm"]')).toMatch(/límite 90\.0 %/);
  });
});
