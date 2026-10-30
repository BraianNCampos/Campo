import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetDef } from '@campo/shared';
import { emptyBatch } from '@/lib/batcher';
import { isUncataloged } from '@/lib/catalog';
import { assetStatus, STATUS_META } from '@/lib/status';
import { useLiveStore } from './live-store';

const def = (id: string, type: AssetDef['type'] = 'tank'): AssetDef => ({ plant: 'demo', id, name: `N-${id}`, type, model3dRef: null, metadata: {} });
const telemetry = (id: string, values: Record<string, number>) => {
  const b = emptyBatch();
  b.telemetry[id] = { ts: 10, quality: 'good', values };
  return b;
};
const s = () => useLiveStore.getState();

beforeEach(() => s().reset());

describe('store: catálogo + telemetría', () => {
  it('un activo del catálogo sin telemetría aparece en la lista con estado "Sin datos"', () => {
    s().setCatalog([def('tk-01'), def('s-1', 'sensor')]);
    expect(s().catalogReady).toBe(true);
    expect(s().assetIds).toEqual(['tk-01', 's-1']);
    const state = s().assets['s-1'];
    expect(state).toBeUndefined();
    expect(assetStatus(state)).toBe('nodata');
    expect(STATUS_META.nodata.label).toBe('Sin datos');
  });

  it('al llegar telemetría el activo pasa a "Normal" sin duplicarse', () => {
    s().setCatalog([def('tk-01')]);
    s().applyBatch(telemetry('tk-01', { level: 40 }));
    expect(s().assetIds).toEqual(['tk-01']);
    expect(assetStatus(s().assets['tk-01'])).toBe('ok');
  });

  it('telemetría de un activo fuera del catálogo → "No catalogado" (con catálogo cargado)', () => {
    s().setCatalog([def('tk-01')]);
    s().applyBatch(telemetry('x-9', { level: 1 }));
    expect(s().assetIds).toContain('x-9');
    expect(isUncataloged('x-9', s().catalog, s().catalogReady)).toBe(true);
    expect(isUncataloged('tk-01', s().catalog, s().catalogReady)).toBe(false);
  });

  it('antes de cargar el catálogo nada es "no catalogado"; la lista sale de la telemetría como siempre', () => {
    s().applyBatch(telemetry('x-9', { level: 1 }));
    expect(s().assetIds).toEqual(['x-9']);
    expect(s().catalogReady).toBe(false);
    expect(isUncataloged('x-9', s().catalog, s().catalogReady)).toBe(false);
  });

  it('un snapshot nuevo no quita del listado a los activos del catálogo sin datos', () => {
    s().setCatalog([def('tk-01'), def('tk-02')]);
    const b = emptyBatch();
    b.snapshot = { type: 'snapshot', plant: 'demo', assets: { 'tk-01': { ts: 1, quality: 'good', values: { level: 1 } } } };
    s().applyBatch(b);
    expect(s().assetIds).toEqual(['tk-01', 'tk-02']);
  });

  it('recargar un catálogo idéntico no cambia referencias (sin re-renders ni reconstruir el 3D)', () => {
    s().setCatalog([def('tk-01'), def('tk-02')]);
    const { catalog, assetIds } = s();
    s().setCatalog([def('tk-01'), def('tk-02')]);
    expect(s().catalog).toBe(catalog);
    expect(s().assetIds).toBe(assetIds);
    s().setCatalog([def('tk-01')]); // cambia: baja un activo
    expect(s().assetIds).toEqual(['tk-01']);
    expect(s().catalog).not.toBe(catalog);
  });

  it('borrar un activo del catálogo conserva el que aún envía telemetría (como "no catalogado")', () => {
    s().setCatalog([def('tk-01'), def('tk-02')]);
    s().applyBatch(telemetry('tk-02', { level: 3 }));
    s().setCatalog([def('tk-01')]);
    expect(s().assetIds).toEqual(['tk-01', 'tk-02']);
    expect(isUncataloged('tk-02', s().catalog, true)).toBe(true);
  });

  it('el telemetría por mensaje no toca catalog ni assetIds (sin re-render por mensaje)', () => {
    s().setCatalog([def('tk-01')]);
    s().applyBatch(telemetry('tk-01', { level: 1 }));
    const { catalog, assetIds } = s();
    for (let i = 0; i < 20; i++) s().applyBatch(telemetry('tk-01', { level: i }));
    expect(s().catalog).toBe(catalog);
    expect(s().assetIds).toBe(assetIds);
  });

  it('error de catálogo se marca y se limpia con la siguiente carga', () => {
    s().setCatalogError(true);
    expect(s().catalogError).toBe(true);
    s().setCatalog([]);
    expect(s().catalogError).toBe(false);
    expect(s().catalogReady).toBe(true);
  });
});
