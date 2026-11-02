import { describe, expect, it } from 'vitest';
import {
  CONTROL_TYPES, domainFormFrom, emptyControlForm, emptyDomainForm, emptyLayoutForm, mergeDomainIntoMetadata, supportsControl, validateAssetForm, validateControlForm, validateDomainForm, validateMetadataDomain,
  type AssetForm,
} from './validation';
import { MockAdminApi } from './mock-api';

const form = (over: Partial<AssetForm> = {}): AssetForm => ({
  id: 'silo-9', name: 'Silo', type: 'silo', model3dRef: '', layout: emptyLayoutForm(), connectsTo: [], metadataText: '', domain: emptyDomainForm(), tag: 'TNK-305', ...over,
});

describe('tag en el formulario de activos', () => {
  it('se guarda en mayúsculas; vacío = sin tag (null); sin el campo no se toca', () => {
    expect(validateAssetForm(form({ tag: 'tnk-305' })).value?.tag).toBe('TNK-305');
    expect(validateAssetForm(form({ tag: '' })).value?.tag).toBeNull();
    expect(validateAssetForm(form({ tag: undefined })).value).not.toHaveProperty('tag');
  });
  it('valida el formato y que no se repita en la planta', () => {
    expect(validateAssetForm(form({ tag: 'ABC-1' })).errors.tag).toMatch(/formato/);
    const others = [{ id: 'silo-1', tag: 'TNK-305' }];
    expect(validateAssetForm(form(), { others }).errors.tag).toMatch(/ya lo usa silo-1/);
    expect(validateAssetForm(form({ id: 'silo-1' }), { others, editing: true }).errors.tag).toBeUndefined();
  });
});

describe('control de llenado en metadata.control (§14.3)', () => {
  it('silos y tanques admiten control', () => {
    expect(CONTROL_TYPES).toEqual(['tank', 'silo']);
    expect(supportsControl('silo') && supportsControl('tank')).toBe(true);
    expect(supportsControl('pump')).toBe(false);
  });
  it('el formulario lee y escribe enabled/min/max/duración sin pisar otras claves', () => {
    const f = domainFormFrom({ control: { enabled: true, minTarget: 10, maxTarget: 90, maxDurationMinutes: 60 }, capacityM3: 120 });
    expect(f.control).toEqual({ enabled: true, minTarget: '10', maxTarget: '90', maxDurationMinutes: '60' });
    const v = validateDomainForm({ ...f, control: { ...f.control!, maxTarget: '85' } }, 'silo');
    expect(v.errors).toEqual({});
    expect(mergeDomainIntoMetadata({ notas: 'x', control: { enabled: true } }, v.value)).toEqual({
      notas: 'x', capacityM3: 120, control: { enabled: true, minTarget: 10, maxTarget: 85, maxDurationMinutes: 60 },
    });
  });
  it('apagado y vacío quita la clave; para otros tipos no se toca', () => {
    expect(validateControlForm(emptyControlForm()).value).toBeNull();
    expect(mergeDomainIntoMetadata({ control: { enabled: true } }, { control: null })).toEqual({});
    expect(validateDomainForm({ ...emptyDomainForm(), control: { ...emptyControlForm(), enabled: true } }, 'pump').value).not.toHaveProperty('control');
  });
  it('valida rangos: objetivos 1–99, mínimo < máximo, duración entera', () => {
    expect(validateControlForm({ enabled: true, minTarget: '0', maxTarget: '', maxDurationMinutes: '' }).errors.controlMin).toMatch(/entre 1 y 99/);
    expect(validateControlForm({ enabled: true, minTarget: '', maxTarget: '100', maxDurationMinutes: '' }).errors.controlMax).toMatch(/entre 1 y 99/);
    expect(validateControlForm({ enabled: true, minTarget: '60', maxTarget: '50', maxDurationMinutes: '' }).errors.controlMax).toMatch(/mayor que el mínimo/);
    expect(validateControlForm({ enabled: true, minTarget: '', maxTarget: '', maxDurationMinutes: '1,5' }).errors.controlDuration).toBeDefined();
    expect(validateControlForm({ enabled: true, minTarget: '5', maxTarget: '95', maxDurationMinutes: '120' }).value).toEqual({ enabled: true, minTarget: 5, maxTarget: 95, maxDurationMinutes: 120 });
  });
  it('lo escrito a mano en el JSON también se valida', () => {
    expect(validateMetadataDomain({ control: { enabled: true, minTarget: 10, maxTarget: 90 } })).toEqual([]);
    expect(validateMetadataDomain({ control: 'sí' })[0]).toMatch(/control debe ser un objeto/);
    expect(validateMetadataDomain({ control: { enabled: 'sí' } })[0]).toMatch(/enabled/);
    expect(validateMetadataDomain({ control: { enabled: true, minTarget: 95, maxTarget: 90 } }).join(' ')).toMatch(/minTarget tiene que ser menor/);
    expect(validateMetadataDomain({ control: { enabled: true, maxDurationMinutes: 0 } })[0]).toMatch(/maxDurationMinutes/);
  });
});

describe('MockAdminApi: tags', () => {
  const api = () => new MockAdminApi({ role: 'admin', now: () => 1_800_000_000_000 });
  it('la semilla trae tags (TNK-101…, TNK-301 en silos, CONV-101) y la nave no tiene', async () => {
    const list = await api().listAssets('demo');
    const tag = (id: string) => list.find((a) => a.id === id)?.tag;
    expect([tag('tk-01'), tag('pump-01'), tag('valve-02'), tag('silo-01'), tag('conv-02'), tag('maq-01'), tag('clima-01')]).toEqual(['TNK-101', 'PMP-101', 'VLV-102', 'TNK-301', 'CONV-102', 'MTR-101', 'XMTR-101']);
    expect(tag('nave-01')).toBeUndefined();
    expect(list.every((a) => !a.tag || /^[A-Z]+-\d{3}$/.test(a.tag))).toBe(true);
  });
  it('crear con tag: se guarda en mayúsculas; repetido → 409; inválido → 400; editar y quitar', async () => {
    const a = api();
    const c = await a.createAsset('demo', { id: 'tk-09', name: 'T9', type: 'tank', tag: 'tnk-105' });
    expect(c.tag).toBe('TNK-105');
    await expect(a.createAsset('demo', { id: 'tk-10', name: 'T10', type: 'tank', tag: 'TNK-105' })).rejects.toMatchObject({ status: 409 });
    await expect(a.createAsset('demo', { id: 'tk-11', name: 'T11', type: 'tank', tag: 'MAL' })).rejects.toMatchObject({ status: 400 });
    expect((await a.updateAsset('demo', 'tk-09', { tag: 'TNK-106' })).tag).toBe('TNK-106');
    expect((await a.updateAsset('demo', 'tk-09', { tag: null })).tag).toBeUndefined();
    expect((await a.updateAsset('demo', 'tk-09', { name: 'otro' })).name).toBe('otro');
  });
  it('un tag repetido (distinguiendo mayúsculas) se rechaza también al editar', async () => {
    const a = api();
    await expect(a.updateAsset('demo', 'tk-02', { tag: 'tnk-101' })).rejects.toMatchObject({ status: 409 });
  });
});
