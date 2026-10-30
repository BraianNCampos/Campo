import { describe, expect, it } from 'vitest';
import type { AssetDef } from '@campo/shared';
import { catalogMap, isUncataloged, mergeAssetIds, modelIdOf, parseConnectsTo, parseLayout, sameCatalog, sceneEntries } from './catalog';

const UUID = '3f2b8c1e-0a4d-4e6f-9b1a-2c3d4e5f6a7b';
const def = (id: string, type: AssetDef['type'], over: Partial<AssetDef> = {}): AssetDef => ({
  plant: 'demo', id, name: id.toUpperCase(), type, model3dRef: null, metadata: {}, ...over,
});

describe('parseLayout', () => {
  it('acepta x/z y los opcionales dentro de rango', () => {
    expect(parseLayout({ layout: { x: 1, z: -2 } })).toEqual({ x: 1, z: -2 });
    expect(parseLayout({ layout: { x: 1, z: 2, y: 0.5, rotY: 90, scale: 3 } })).toEqual({ x: 1, z: 2, y: 0.5, rotY: 90, scale: 3 });
  });
  it('rechaza lo que incumple el contrato (→ layout automático)', () => {
    for (const layout of [undefined, null, 5, [], {}, { x: 1 }, { x: '1', z: 2 }, { x: 1001, z: 0 }, { x: 0, z: 0, y: -1001 }, { x: 0, z: 0, scale: 0.01 }, { x: 0, z: 0, scale: 51 }, { x: 0, z: 0, rotY: NaN }]) {
      expect(parseLayout({ layout })).toBeUndefined();
    }
    expect(parseLayout(null)).toBeUndefined();
    expect(parseLayout({ layout: { x: 1000, z: -1000, scale: 50 } })).toEqual({ x: 1000, z: -1000, scale: 50 });
  });
});

describe('parseConnectsTo / modelIdOf', () => {
  it('connectsTo: sólo cadenas únicas y no vacías', () => {
    expect(parseConnectsTo({ connectsTo: ['a', 'b', 'a', '', 3] })).toEqual(['a', 'b']);
    expect(parseConnectsTo({ connectsTo: 'a' })).toEqual([]);
    expect(parseConnectsTo({})).toEqual([]);
  });
  it('model:<uuid> → uuid; el resto, null', () => {
    expect(modelIdOf(`model:${UUID}`)).toBe(UUID);
    for (const ref of [null, undefined, '', 'tank', 'model:x', `model:${UUID}0`]) expect(modelIdOf(ref)).toBeNull();
  });
});

describe('fusión catálogo + telemetría', () => {
  const catalog = catalogMap([def('tk-01', 'tank'), def('s-1', 'sensor'), def('pump-01', 'pump')]);
  const telemetry = { 'tk-01': { ts: 1, quality: 'good' as const, values: { level: 5 } }, 'zz-extra': { ts: 1, quality: 'good' as const, values: { v: 1 } } };

  it('une ids (catálogo ∪ telemetría) ordenados por tipo del catálogo y luego id', () => {
    expect(mergeAssetIds(catalog, telemetry)).toEqual(['tk-01', 'pump-01', 's-1', 'zz-extra']);
    expect(mergeAssetIds({}, {})).toEqual([]);
  });
  it('un activo del catálogo sin telemetría está en la lista; uno sin catálogo es "no catalogado" (sólo con el catálogo cargado)', () => {
    const ids = mergeAssetIds(catalog, telemetry);
    expect(ids).toContain('s-1');
    expect(isUncataloged('zz-extra', catalog, true)).toBe(true);
    expect(isUncataloged('zz-extra', catalog, false)).toBe(false); // todavía no se sabe
    expect(isUncataloged('tk-01', catalog, true)).toBe(false);
    expect(isUncataloged('s-1', catalog, true)).toBe(false);
  });
  it('sameCatalog detecta cambios de contenido pero no de referencia', () => {
    const a = catalogMap([def('a', 'tank', { metadata: { layout: { x: 1, z: 2 } } })]);
    const b = catalogMap([def('a', 'tank', { metadata: { layout: { x: 1, z: 2 } } })]);
    expect(sameCatalog(a, b)).toBe(true);
    expect(sameCatalog(a, catalogMap([def('a', 'tank', { metadata: { layout: { x: 9, z: 2 } } })]))).toBe(false);
    expect(sameCatalog(a, catalogMap([def('a', 'pump')]))).toBe(false);
    expect(sameCatalog(a, catalogMap([def('a', 'tank'), def('b', 'tank')]))).toBe(false);
    expect(sameCatalog(a, catalogMap([def('a', 'tank', { model3dRef: `model:${UUID}`, metadata: { layout: { x: 1, z: 2 } } })]))).toBe(false);
  });
});

describe('sceneEntries', () => {
  it('dibuja los del catálogo por su tipo; los sin catálogo, por el id (tanque/bomba/válvula); el resto no', () => {
    const catalog = catalogMap([
      def('x1', 'sensor', { metadata: { layout: { x: 2, z: 3 }, connectsTo: ['tk-01'] } }),
      def('tk-01', 'pump'), // el tipo del catálogo manda sobre el id
    ]);
    const entries = sceneEntries(['tk-01', 'x1', 'pump-09', 'otro'], catalog);
    expect(entries.map((e) => [e.id, e.type])).toEqual([['tk-01', 'pump'], ['x1', 'sensor'], ['pump-09', 'pump']]);
    expect(entries[1]).toMatchObject({ layout: { x: 2, z: 3 }, connectsTo: ['tk-01'], name: 'X1' });
    expect(entries[2]).toMatchObject({ name: 'Bomba 09', model3dRef: null, connectsTo: [] });
  });
});
