// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Role } from '@campo/shared';
import type { AdminApiError } from './errors';
import { ModelInUseError } from './errors';
import { MockAdminApi } from './mock-api';
import { MODEL_MAX_BYTES } from './models';

const here = dirname(fileURLToPath(import.meta.url));
const sample = (n: string) => new Blob([readFileSync(resolve(here, '../../../../../examples/models', `${n}.glb`))]);
const make = (role: Role = 'admin') => new MockAdminApi({ role, now: () => 1_800_000_000_000 });
const err = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as AdminApiError;

describe('MockAdminApi: modelos 3D', () => {
  it('sube un GLB válido, lo lista y devuelve los mismos bytes; reenviarlo devuelve el existente (created=false)', async () => {
    const api = make();
    const progress = vi.fn();
    const up = await api.uploadModel('demo', sample('sample-tank'), 'Tanque', { onProgress: progress });
    expect(up.created).toBe(true);
    expect(up.model).toMatchObject({ plant: 'demo', name: 'Tanque', size: 2940 });
    expect(up.model.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(progress.mock.calls.at(-1)).toEqual([2940, 2940]);
    expect(await api.listModels('demo')).toEqual([up.model]);
    const bytes = new Uint8Array(await api.downloadModel(up.model.id));
    expect(bytes.length).toBe(2940);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('glTF');

    const again = await api.uploadModel('demo', sample('sample-tank'), 'Otro nombre');
    expect(again.created).toBe(false);
    expect(again.model.id).toBe(up.model.id);
    expect(await api.listModels('demo')).toHaveLength(1);
  });

  it('400 en español con basura, cabecera falsa, truncado y extensiones no admitidas; 413 por tamaño', async () => {
    const api = make();
    const text = (s: string) => new Blob([s]);
    expect((await err(api.uploadModel('demo', text('hola, esto no es un modelo 3D'), 'x'))).message).toMatch(/^GLB no válido: /);
    expect((await err(api.uploadModel('demo', text('x'), 'x'))).status).toBe(400);
    const good = readFileSync(resolve(here, '../../../../../examples/models/sample-pump.glb'));
    const trunc = await err(api.uploadModel('demo', new Blob([good.subarray(0, good.length - 10)]), 'x'));
    expect(trunc.status).toBe(400);
    expect(trunc.message).toMatch(/truncado|corrupto/);
    const big = await err(api.uploadModel('demo', new Blob([new Uint8Array(MODEL_MAX_BYTES + 1)]), 'x'));
    expect(big.status).toBe(413);
    expect(big.kind).toBe('too_large');
    expect(big.message).toBe('El modelo supera el límite de 10 MB');
    expect((await err(api.uploadModel('demo', sample('sample-tank'), '  '))).status).toBe(400);
    expect(await api.listModels('demo')).toEqual([]);
  });

  it('GLB con Draco, URIs externas o extensiones requeridas fuera de la lista → 400', async () => {
    const api = make();
    const mk = (extra: Record<string, unknown>) => {
      const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...extra }));
      const pad = (4 - (json.length % 4)) % 4;
      const out = new Uint8Array(20 + json.length + pad);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
      dv.setUint32(12, json.length + pad, true); dv.setUint32(16, 0x4e4f534a, true);
      out.set(json, 20); out.fill(0x20, 20 + json.length);
      return new Blob([out]);
    };
    expect((await err(api.uploadModel('demo', mk({ extensionsUsed: ['KHR_draco_mesh_compression'] }), 'x'))).message).toMatch(/Draco/);
    expect((await err(api.uploadModel('demo', mk({ extensionsRequired: ['EXT_foo'] }), 'x'))).message).toMatch(/EXT_foo/);
    expect((await err(api.uploadModel('demo', mk({ buffers: [{ byteLength: 3, uri: 'https://x.test/a.bin' }] }), 'x'))).message).toMatch(/autocontenido/);
    expect((await err(api.uploadModel('demo', mk({ nodes: new Array(2001).fill({}) }), 'x'))).message).toMatch(/nodos/);
    // extensión admitida: pasa
    expect((await api.uploadModel('demo', mk({ extensionsRequired: ['KHR_materials_unlit'] }), 'ok')).created).toBe(true);
  });

  it('permisos: operator/viewer no suben ni borran (403); otra planta → 403/404', async () => {
    expect((await err(make('operator').uploadModel('demo', sample('sample-tank'), 'x'))).kind).toBe('forbidden');
    expect((await err(make('operator').deleteModel('demo', 'x'))).kind).toBe('forbidden');
    expect((await err(make().uploadModel('nada', sample('sample-tank'), 'x'))).kind).toBe('not_found');
    expect((await make('operator').listModels('demo'))).toEqual([]); // cualquier rol con acceso lista
  });

  it('el valor antiguo de model3dRef (tk-01 = "tank") se tolera si se reenvía igual, no otro texto libre', async () => {
    const api = make();
    expect((await api.listAssets('demo')).find((a) => a.id === 'tk-01')?.model3dRef).toBe('tank');
    expect((await api.updateAsset('demo', 'tk-01', { name: 'T1', model3dRef: 'tank' })).model3dRef).toBe('tank');
    expect((await err(api.updateAsset('demo', 'tk-01', { model3dRef: 'otro' }))).kind).toBe('validation');
    expect((await api.updateAsset('demo', 'tk-01', { model3dRef: null })).model3dRef).toBeNull();
  });

  it('un activo referencia un modelo de su planta (model3dRef) y no uno inexistente o de otra planta', async () => {
    const api = make();
    await api.createPlant({ id: 'norte', name: 'Norte' });
    const m = (await api.uploadModel('demo', sample('sample-tank'), 'T')).model;
    const other = (await api.uploadModel('norte', sample('sample-valve'), 'V')).model;
    const a = await api.createAsset('demo', { id: 'tk-09', name: 'T9', type: 'tank', model3dRef: `model:${m.id}` });
    expect(a.model3dRef).toBe(`model:${m.id}`);
    for (const model3dRef of ['tank', `model:${other.id}`, 'model:00000000-0000-4000-8000-0000000000ff']) {
      const e = await err(api.createAsset('demo', { id: 'x', name: 'x', type: 'tank', model3dRef }));
      expect(e.kind).toBe('validation');
      expect(e.message).toMatch(/model3dRef|Modelo 3D/);
    }
    const quitado = await api.updateAsset('demo', 'tk-09', { model3dRef: null });
    expect(quitado.model3dRef).toBeNull();
  });

  it('borrar un modelo en uso → 409 con la lista de activos; libre → se borra, 404 después', async () => {
    const api = make();
    const m = (await api.uploadModel('demo', sample('sample-pump'), 'P')).model;
    await api.createAsset('demo', { id: 'a1', name: 'A1', type: 'pump', model3dRef: `model:${m.id}` });
    await api.createAsset('demo', { id: 'a2', name: 'A2', type: 'pump', model3dRef: `model:${m.id}` });
    const e = (await err(api.deleteModel('demo', m.id))) as ModelInUseError;
    expect(e).toBeInstanceOf(ModelInUseError);
    expect(e.status).toBe(409);
    expect(e.assets).toEqual(['a1', 'a2']);
    await api.updateAsset('demo', 'a1', { model3dRef: null });
    await api.updateAsset('demo', 'a2', { model3dRef: null });
    await api.deleteModel('demo', m.id);
    expect(await api.listModels('demo')).toEqual([]);
    expect((await err(api.deleteModel('demo', m.id))).kind).toBe('not_found');
    expect((await err(api.downloadModel(m.id))).kind).toBe('not_found');
  });

  it('auditoría model.upload / model.delete (sin contenido)', async () => {
    const api = make();
    const m = (await api.uploadModel('demo', sample('sample-static'), 'S')).model;
    await api.deleteModel('demo', m.id);
    const audit = await api.listAudit({ action: 'model' });
    expect(audit.map((a) => a.action)).toEqual(['model.delete', 'model.upload']);
    expect(JSON.stringify(audit)).not.toMatch(/glTF/);
  });

  it('metadata.layout/connectsTo: 400 si incumple los rangos; aviso si conecta con un activo inexistente', async () => {
    const api = make();
    for (const metadata of [{ layout: { x: 5000, z: 0 } }, { layout: { x: 0 } }, { layout: { x: 0, z: 0, scale: 100 } }, { connectsTo: ['tk-01', 'tk-01'] }, { connectsTo: ['a1'] }, { connectsTo: 'x' }]) {
      expect((await err(api.createAsset('demo', { id: 'a1', name: 'A', type: 'tank', metadata }))).kind).toBe('validation');
    }
    const ok = await api.createAsset('demo', { id: 'a1', name: 'A', type: 'tank', metadata: { layout: { x: 1, z: 2 }, connectsTo: ['tk-01', 'fantasma'], otra: 'clave' } });
    expect(ok.warnings).toHaveLength(1);
    expect(ok.warnings![0]).toContain('fantasma');
    expect(ok.metadata).toEqual({ layout: { x: 1, z: 2 }, connectsTo: ['tk-01'], otra: 'clave' }); // el inexistente no se guarda
    expect((await api.createAsset('demo', { id: 'a2', name: 'A', type: 'tank' })).warnings).toBeUndefined();
  });

  it('avisa del cambio de catálogo (alta, edición, baja de activos y de modelos) a quien escuche', async () => {
    const api = make();
    const seen: string[] = [];
    const off = api.onCatalogChange((p) => seen.push(p));
    await api.createAsset('demo', { id: 'z1', name: 'Z', type: 'sensor' });
    await api.updateAsset('demo', 'z1', { name: 'Z2' });
    const m = (await api.uploadModel('demo', sample('sample-tank'), 'T')).model;
    await api.deleteModel('demo', m.id);
    await api.deleteAsset('demo', 'z1');
    expect(seen).toEqual(['demo', 'demo', 'demo', 'demo', 'demo']);
    off();
    await api.createAsset('demo', { id: 'z2', name: 'Z', type: 'sensor' });
    expect(seen).toHaveLength(5);
  });
});
