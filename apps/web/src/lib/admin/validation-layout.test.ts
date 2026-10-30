import { describe, expect, it } from 'vitest';
import {
  emptyLayoutForm,
  fieldsFromMetadataText,
  layoutFormFrom,
  mergeLayoutIntoMetadata,
  parseNum,
  syncMetadataText,
  validateAssetForm,
  validateLayoutForm,
  validateMetadataLayout,
  type AssetForm,
} from './validation';
import { formatBytes, modelNameFromFile, modelUsage, MODEL_MAX_BYTES, validateModelFile } from './models';

const UUID = '3f2b8c1e-0a4d-4e6f-9b1a-2c3d4e5f6a7b';
const layout = (o: Partial<ReturnType<typeof emptyLayoutForm>>) => ({ ...emptyLayoutForm(), ...o });
const base: AssetForm = { id: 'tk-05', name: 'Tanque', type: 'tank', model3dRef: '', layout: emptyLayoutForm(), connectsTo: [], metadataText: '' };

describe('parseNum', () => {
  it('vacío → undefined; coma decimal; basura → NaN', () => {
    expect(parseNum('')).toBeUndefined();
    expect(parseNum('  ')).toBeUndefined();
    expect(parseNum('1,5')).toBe(1.5);
    expect(parseNum('-3')).toBe(-3);
    expect(parseNum('.5')).toBe(0.5);
    for (const bad of ['abc', '1e', '--1', '1,2,3', 'Infinity', '0x10']) expect(parseNum(bad)).toBeNaN();
  });
});

describe('validateLayoutForm (rangos del contrato)', () => {
  it('todo vacío → sin layout propio (null)', () => {
    expect(validateLayoutForm(emptyLayoutForm())).toEqual({ errors: {}, value: null });
  });
  it('X y Z bastan; los opcionales sólo si se rellenan', () => {
    expect(validateLayoutForm(layout({ x: '3', z: '-2' })).value).toEqual({ x: 3, z: -2 });
    expect(validateLayoutForm(layout({ x: '3', z: '2,5', y: '1', rotY: '90', scale: '3,5' })).value).toEqual({ x: 3, z: 2.5, y: 1, rotY: 90, scale: 3.5 });
  });
  it('rangos: |x|,|z|,|y| ≤ 1000 y escala 0,05–50', () => {
    expect(validateLayoutForm(layout({ x: '1001', z: '0' })).errors.layoutX).toMatch(/entre -1000 y 1000/);
    expect(validateLayoutForm(layout({ x: '0', z: '-1000.5' })).errors.layoutZ).toBeDefined();
    expect(validateLayoutForm(layout({ x: '0', z: '0', y: '2000' })).errors.layoutY).toBeDefined();
    expect(validateLayoutForm(layout({ x: '0', z: '0', scale: '0,01' })).errors.layoutScale).toMatch(/0,05 y 50/);
    expect(validateLayoutForm(layout({ x: '0', z: '0', scale: '51' })).errors.layoutScale).toBeDefined();
    expect(validateLayoutForm(layout({ x: '1000', z: '-1000', scale: '50' })).errors).toEqual({});
    expect(validateLayoutForm(layout({ x: '0', z: '0', scale: '0.05' })).errors).toEqual({});
  });
  it('texto no numérico y pares incompletos', () => {
    expect(validateLayoutForm(layout({ x: 'abc', z: '1' })).errors.layoutX).toMatch(/número/);
    expect(validateLayoutForm(layout({ x: '1' })).errors.layoutZ).toMatch(/X y Z/);
    expect(validateLayoutForm(layout({ rotY: '45' })).errors.layoutX).toMatch(/X y Z/);
  });
  it('rotación libre (grados, incluso negativos o >360)', () => {
    expect(validateLayoutForm(layout({ x: '0', z: '0', rotY: '-450' })).value).toMatchObject({ rotY: -450 });
  });
});

describe('metadata: layout/connectsTo sin pisar otras claves', () => {
  it('mergeLayoutIntoMetadata conserva el resto de claves y su orden', () => {
    const meta = { capacityL: 5000, notas: { a: 1 }, layout: { x: 1, z: 1 } };
    expect(mergeLayoutIntoMetadata(meta, { x: 9, z: 8 }, ['a', 'b'])).toEqual({ capacityL: 5000, notas: { a: 1 }, layout: { x: 9, z: 8 }, connectsTo: ['a', 'b'] });
    expect(Object.keys(mergeLayoutIntoMetadata(meta, { x: 9, z: 8 }, undefined))).toEqual(['capacityL', 'notas', 'layout']);
    expect(mergeLayoutIntoMetadata(meta, null, [])).toEqual({ capacityL: 5000, notas: { a: 1 } });
    expect(mergeLayoutIntoMetadata(meta, undefined, undefined)).toEqual(meta);
    expect(meta.layout).toEqual({ x: 1, z: 1 }); // no muta
  });
  it('syncMetadataText reescribe el JSON; si el JSON es inválido no lo toca (null)', () => {
    const text = JSON.stringify({ capacityL: 5000 });
    const out = syncMetadataText(text, { x: 2, z: 3 }, ['p1'])!;
    expect(JSON.parse(out)).toEqual({ capacityL: 5000, layout: { x: 2, z: 3 }, connectsTo: ['p1'] });
    expect(syncMetadataText('{"a":', { x: 2, z: 3 }, [])).toBeNull();
    expect(syncMetadataText('', { x: 1, z: 1 }, undefined)).toBe(JSON.stringify({ layout: { x: 1, z: 1 } }, null, 2));
    expect(syncMetadataText('{"layout":{"x":1,"z":1}}', null, undefined)).toBe(''); // queda vacío → '' (={})
  });
  it('fieldsFromMetadataText rellena los campos a partir del JSON', () => {
    const f = fieldsFromMetadataText('{"layout":{"x":1.5,"z":-2,"rotY":90},"connectsTo":["a","b"],"otra":1}')!;
    expect(f.layout).toEqual({ x: '1.5', z: '-2', y: '', rotY: '90', scale: '' });
    expect(f.connectsTo).toEqual(['a', 'b']);
    expect(fieldsFromMetadataText('no json')).toBeNull();
    expect(layoutFormFrom({})).toEqual(emptyLayoutForm());
  });
  it('validateMetadataLayout: layout y connectsTo según §10.3', () => {
    expect(validateMetadataLayout({})).toEqual([]);
    expect(validateMetadataLayout({ layout: { x: 1, z: 2, rotY: 10, scale: 1 }, connectsTo: ['a'] }, 'tk-01')).toEqual([]);
    expect(validateMetadataLayout({ layout: 5 })[0]).toMatch(/objeto/);
    expect(validateMetadataLayout({ layout: { x: 1 } })[0]).toMatch(/layout no es válido/);
    expect(validateMetadataLayout({ connectsTo: 'a' })[0]).toMatch(/lista/);
    expect(validateMetadataLayout({ connectsTo: ['A b'] })[0]).toMatch(/lista/);
    expect(validateMetadataLayout({ connectsTo: ['a', 'a'] })[0]).toMatch(/repetidos/);
    expect(validateMetadataLayout({ connectsTo: ['tk-01'] }, 'tk-01')[0]).toMatch(/propio activo/);
    expect(validateMetadataLayout({ connectsTo: Array.from({ length: 33 }, (_, i) => `a${i}`) })[0]).toMatch(/32/);
  });
});

describe('validateAssetForm con modelo, disposición y conexiones', () => {
  it('compone model3dRef + layout + connectsTo conservando las claves manuales del JSON', () => {
    const r = validateAssetForm({
      ...base,
      model3dRef: `model:${UUID}`,
      layout: layout({ x: '4', z: '-1,5', scale: '3' }),
      connectsTo: ['pump-01'],
      metadataText: '{"capacityL": 5000, "tags": ["a"]}',
    });
    expect(r.errors).toEqual({});
    expect(r.value).toEqual({
      id: 'tk-05', name: 'Tanque', type: 'tank', model3dRef: `model:${UUID}`,
      metadata: { capacityL: 5000, tags: ['a'], layout: { x: 4, z: -1.5, scale: 3 }, connectsTo: ['pump-01'] },
    });
  });
  it('model3dRef sólo "" o model:<uuid>', () => {
    expect(validateAssetForm({ ...base, model3dRef: 'tank' }).errors.model3dRef).toBeDefined();
    expect(validateAssetForm({ ...base, model3dRef: 'model:123' }).errors.model3dRef).toBeDefined();
    expect(validateAssetForm({ ...base, model3dRef: '' }).value?.model3dRef).toBeNull();
  });
  it('errores de layout y de JSON bloquean y se indican por campo', () => {
    const r = validateAssetForm({ ...base, layout: layout({ x: '9999', z: '0' }) });
    expect(r.value).toBeUndefined();
    expect(r.errors.layoutX).toBeDefined();
    expect(validateAssetForm({ ...base, layout: layout({ x: '1' }) }).errors.layoutZ).toBeDefined();
    // JSON a mano con un layout inválido
    expect(validateAssetForm({ ...base, metadataText: '{"layout":{"x":1}}' }).errors.metadata).toMatch(/layout/);
    expect(validateAssetForm({ ...base, metadataText: '{"connectsTo":["tk-05"]}' }).errors.metadata).toMatch(/propio/);
    expect(validateAssetForm({ ...base, connectsTo: ['tk-05'] }).errors.connectsTo).toBeDefined();
    expect(validateAssetForm({ ...base, connectsTo: Array.from({ length: 33 }, (_, i) => `a${i}`) }).errors.connectsTo).toMatch(/32/);
  });
  it('sin disposición: no añade claves a los metadatos', () => {
    expect(validateAssetForm({ ...base, metadataText: '{"a":1}' }).value?.metadata).toEqual({ a: 1 });
  });
});

describe('archivos de modelo (cliente)', () => {
  it('extensión .glb, no vacío y ≤ 10 MB', () => {
    expect(validateModelFile({ name: 'tanque.glb', size: 1000 })).toBeNull();
    expect(validateModelFile({ name: 'TANQUE.GLB', size: MODEL_MAX_BYTES })).toBeNull();
    expect(validateModelFile({ name: 'tanque.gltf', size: 1000 })).toMatch(/\.glb/);
    expect(validateModelFile({ name: 'tanque.png', size: 1000 })).toMatch(/\.glb/);
    expect(validateModelFile({ name: 'a.glb', size: 0 })).toMatch(/vacío/);
    expect(validateModelFile({ name: 'a.glb', size: MODEL_MAX_BYTES + 1 })).toMatch(/máximo es 10 MB/);
  });
  it('formatBytes y nombre a partir del archivo', () => {
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(2940)).toBe('2,9 KB');
    expect(formatBytes(340 * 1024)).toBe('340 KB');
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1,2 MB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatBytes(NaN)).toBe('—');
    expect(modelNameFromFile('mi_tanque_nuevo.GLB')).toBe('mi tanque nuevo');
    expect(modelNameFromFile('.glb')).toBe('modelo');
    expect(modelNameFromFile('x'.repeat(200) + '.glb')).toHaveLength(100);
  });
  it('uso de cada modelo por los activos', () => {
    expect(modelUsage([{ id: 'a', model3dRef: `model:${UUID}` }, { id: 'b', model3dRef: `model:${UUID}` }, { id: 'c', model3dRef: null }, { id: 'd', model3dRef: 'tank' }])).toEqual({ [UUID]: ['a', 'b'] });
  });
});
