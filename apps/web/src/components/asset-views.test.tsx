import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssetDef } from '@campo/shared';
import { emptyBatch } from '@/lib/batcher';
import { useLiveStore } from '@/store/live-store';
import { useUiStore } from '@/store/ui-store';
import { AssetCard } from './AssetCard';
import { AssetList } from './AssetList';
import { EmptyAssets } from './EmptyAssets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useLiveStore.getState().reset();
  useUiStore.getState().select(null);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (el: React.ReactElement) => act(() => root.render(el));
const def = (id: string, type: AssetDef['type'], name = id): AssetDef => ({ plant: 'demo', id, name, type, model3dRef: null, metadata: {} });
const feed = (id: string, values: Record<string, number>) => {
  const b = emptyBatch();
  b.telemetry[id] = { ts: 1, quality: 'good', values };
  act(() => useLiveStore.getState().applyBatch(b));
};

describe('lista de escritorio', () => {
  it('activo del catálogo sin telemetría: "Sin datos", icono propio, sin valor', () => {
    act(() => useLiveStore.getState().setCatalog([def('tk-01', 'tank', 'Depósito norte'), def('sen-1', 'sensor', 'Sonda pH')]));
    render(<AssetList />);
    const row = host.querySelector('[data-testid="asset-row-sen-1"]')!;
    expect(row.textContent).toContain('Sonda pH');
    expect(host.querySelector('[data-testid="row-status-sen-1"]')?.textContent).toBe('Sin datos');
    expect(row.querySelector('[data-testid="row-value-sen-1"]')).toBeNull();
    expect(row.querySelector('svg')).not.toBeNull();
    expect(host.querySelector('[data-testid="row-status-tk-01"]')?.textContent).toBe('Sin datos');
    expect(host.textContent).toContain('Depósito norte'); // nombre del catálogo
    expect(host.textContent).toContain('Sensores'); // grupo por tipo
    expect(host.textContent).not.toContain('Esperando datos');
    expect(host.querySelector('[data-testid="uncataloged"]')).toBeNull();
  });

  it('con telemetría muestra estado y valor; el activo que no está en el catálogo lleva "No catalogado"', () => {
    act(() => useLiveStore.getState().setCatalog([def('tk-01', 'tank')]));
    feed('tk-01', { level: 42 });
    feed('tk-77', { level: 10 });
    render(<AssetList />);
    expect(host.querySelector('[data-testid="row-status-tk-01"]')?.textContent).toBe('Normal');
    expect(host.querySelector('[data-testid="row-value-tk-01"]')?.textContent).toBe('42.0 %');
    const extra = host.querySelector('[data-testid="asset-row-tk-77"]')!;
    expect(extra.querySelector('[data-testid="uncataloged"]')?.textContent).toBe('No catalogado');
    expect(host.querySelector('[data-testid="asset-row-tk-01"] [data-testid="uncataloged"]')).toBeNull();
  });

  it('sin catálogo ni datos: estado vacío claro según el caso', () => {
    render(<AssetList />);
    expect(host.textContent).toContain('Cargando activos');
    act(() => useLiveStore.getState().setCatalogError(true));
    expect(host.textContent).toContain('No pudimos cargar el catálogo');
    act(() => useLiveStore.getState().setCatalog([]));
    expect(host.textContent).toContain('no tiene activos en el catálogo');
  });
});

describe('tarjeta móvil', () => {
  it('activo sin telemetría: insignia "Sin datos", mensaje y sin valores ni curva', () => {
    act(() => useLiveStore.getState().setCatalog([def('pump-9', 'pump', 'Bomba de riego')]));
    render(<AssetCard id="pump-9" />);
    const card = host.querySelector('[data-testid="asset-card-pump-9"]')!;
    expect(card.getAttribute('aria-label')).toBe('Bomba de riego: Sin datos');
    expect(card.textContent).toContain('Sin datos');
    expect(card.textContent).toContain('Todavía no llegaron datos');
    expect(card.querySelector('[data-testid="value-pump-9"]')).toBeNull();
    expect(card.querySelector('canvas')).toBeNull();
    expect(card.textContent).not.toContain('En marcha');
  });
});

describe('EmptyAssets', () => {
  it('es un estado (role=status) accesible', () => {
    render(<EmptyAssets />);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });
});
