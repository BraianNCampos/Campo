import { describe, expect, it } from 'vitest';
import type { AssetDef } from '@campo/shared';
import { assetHref, assetSlug, displayTag, equipmentHref, findAssetBySlug, isValidTag, nextFreeTag, normalizeTag, tagOf, validateTag } from './tags';

const def = (id: string, tag?: string | null): AssetDef => ({ plant: 'demo', id, name: id, type: 'tank', model3dRef: null, metadata: {}, tag });

describe('tags (docs §14.1)', () => {
  it('formato: prefijos válidos, 3-4 cifras y letra opcional', () => {
    for (const t of ['TNK-101', 'PMP-1020', 'XMTR-101A', 'CONV-999']) expect(isValidTag(t)).toBe(true);
    for (const t of ['tnk-101', 'TNK-10', 'ABC-101', 'TNK101', 'TNK-10000', '', null, undefined]) expect(isValidTag(t as string)).toBe(false);
    expect(normalizeTag('  tnk-101 ')).toBe('TNK-101');
  });
  it('se muestra el tag y, sin tag, el id técnico', () => {
    expect(tagOf(def('tk-01', 'TNK-101'))).toBe('TNK-101');
    expect(tagOf(def('tk-01', ''))).toBeNull();
    expect(displayTag('tk-01', def('tk-01', 'TNK-101'))).toBe('TNK-101');
    expect(displayTag('tk-01', undefined)).toBe('tk-01');
  });
  it('rutas: el tag en minúsculas; sin tag, el id', () => {
    expect(assetSlug(def('tk-01', 'TNK-101'))).toBe('tnk-101');
    expect(assetSlug(def('nave-01'))).toBe('nave-01');
    expect(assetHref('tanks', def('tk-01', 'TNK-101'))).toBe('/m/tanks/tnk-101');
    expect(equipmentHref('tanks', def('tk-01', 'TNK-101'))).toBe('/m/tanks/tnk-101/equipo');
  });
  it('findAssetBySlug ignora mayúsculas y cae al id', () => {
    const list = [def('tk-01', 'TNK-101'), def('nave-01')];
    expect(findAssetBySlug(list, 'tnk-101')?.id).toBe('tk-01');
    expect(findAssetBySlug(list, 'TNK-101')?.id).toBe('tk-01');
    expect(findAssetBySlug(list, 'nave-01')?.id).toBe('nave-01');
    expect(findAssetBySlug(list, 'zzz')).toBeUndefined();
    expect(findAssetBySlug({ a: list[0]! }, 'tnk-101')?.id).toBe('tk-01');
  });
  it('nextFreeTag: el siguiente al más alto del prefijo, desde 101', () => {
    expect(nextFreeTag('tank', [])).toBe('TNK-101');
    expect(nextFreeTag('tank', ['TNK-101', 'TNK-102', 'PMP-300'])).toBe('TNK-103');
    expect(nextFreeTag('silo', ['TNK-101', 'TNK-301'])).toBe('TNK-302');
    expect(nextFreeTag('pump', ['TNK-101', null, undefined])).toBe('PMP-101');
    expect(nextFreeTag('conveyor', ['conv-105'])).toBe('CONV-106');
    expect(nextFreeTag('climate', [])).toBe('XMTR-101');
  });
  it('validateTag: opcional, formato y unicidad sin distinguir mayúsculas', () => {
    const others = [{ id: 'tk-01', tag: 'TNK-101' }, { id: 'tk-02', tag: null }];
    expect(validateTag('', others)).toBeNull();
    expect(validateTag('TNK-102', others)).toBeNull();
    expect(validateTag('tnk-101', others)).toMatch(/ya lo usa tk-01/);
    expect(validateTag('tnk-101', others, 'tk-01')).toBeNull(); // el propio
    expect(validateTag('XX-1', others)).toMatch(/formato/);
  });
});
