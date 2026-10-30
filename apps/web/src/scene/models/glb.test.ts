// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createInstance, disposeModel, normalization, parseGlb } from './glb';
import { sampleGlb } from './fixtures';

describe('parseGlb', () => {
  it('analiza los GLB de ejemplo y calcula su caja envolvente', async () => {
    const m = await parseGlb(sampleGlb('sample-tank'));
    expect(m.size.x).toBeCloseTo(2);
    expect(m.size.y).toBeCloseTo(3);
    expect(m.minY).toBeCloseTo(0);
    expect(m.vertices).toBe(48);
    const pump = await parseGlb(sampleGlb('sample-pump'));
    expect(pump.size.y).toBeGreaterThan(1);
  });

  it('rechaza basura, cabeceras falsas y archivos truncados con un Error legible', async () => {
    await expect(parseGlb(new TextEncoder().encode('esto no es un glb en absoluto').buffer as ArrayBuffer)).rejects.toThrow(/GLB/);
    await expect(parseGlb(new ArrayBuffer(4))).rejects.toThrow();
    const good = new Uint8Array(sampleGlb('sample-valve'));
    await expect(parseGlb(good.slice(0, 40).buffer as ArrayBuffer)).rejects.toThrow();
    const corrupt = good.slice();
    corrupt.fill(0x7b, 30, 120); // JSON roto dentro de un contenedor con cabecera válida
    await expect(parseGlb(corrupt.buffer as ArrayBuffer)).rejects.toThrow();
  });

  it('rechaza lo que supera el tamaño máximo sin analizarlo', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set([0x67, 0x6c, 0x54, 0x46]);
    await expect(parseGlb(big.buffer)).rejects.toThrow(/tamaño/);
  });

  it('rechaza modelos que referencian archivos externos', async () => {
    // GLB con una imagen por URI externa: el cargador intentaría descargarla; debe bloquearse
    const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }], bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ byteLength: 36 }] };
    const j = new TextEncoder().encode(JSON.stringify(json));
    const jp = new Uint8Array(Math.ceil(j.length / 4) * 4).fill(0x20);
    jp.set(j);
    const bin = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const out = new Uint8Array(12 + 8 + jp.length + 8 + 36);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
    dv.setUint32(12, jp.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jp, 20);
    dv.setUint32(20 + jp.length, 36, true); dv.setUint32(24 + jp.length, 0x004e4942, true);
    out.set(new Uint8Array(bin.buffer), 28 + jp.length);
    // válido (triángulo)…
    const ok = await parseGlb(out.buffer as ArrayBuffer);
    expect(ok.vertices).toBe(3);
    // …y con un buffer por URI externa: error, no petición de red
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const ext = JSON.stringify({ ...json, buffers: [{ byteLength: 36, uri: 'https://evil.example/x.bin' }] });
    const e = new TextEncoder().encode(ext);
    const ep = new Uint8Array(Math.ceil(e.length / 4) * 4).fill(0x20);
    ep.set(e);
    const bad = new Uint8Array(12 + 8 + ep.length);
    const bv = new DataView(bad.buffer);
    bv.setUint32(0, 0x46546c67, true); bv.setUint32(4, 2, true); bv.setUint32(8, bad.length, true);
    bv.setUint32(12, ep.length, true); bv.setUint32(16, 0x4e4f534a, true); bad.set(ep, 20);
    await expect(parseGlb(bad.buffer as ArrayBuffer)).rejects.toThrow();
    const urls = fetchSpy.mock.calls.map((c) => String((c[0] as { url?: string }).url ?? c[0]));
    expect(urls.some((u) => u.includes('evil'))).toBe(false); // la URL externa se neutraliza antes de pedirla
    vi.unstubAllGlobals();
  });
});

describe('normalization / createInstance / disposeModel', () => {
  it('ajusta a una caja de 1 unidad, centrada en x/z y apoyada en y=0', async () => {
    const m = await parseGlb(sampleGlb('sample-tank'));
    const { k, offset } = normalization(m);
    expect(k).toBeCloseTo(1 / 3);
    const wrapper = new THREE.Group();
    wrapper.scale.setScalar(k);
    wrapper.position.set(...offset);
    wrapper.add(createInstance(m).object);
    wrapper.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrapper);
    const size = box.getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(1, 5);
    expect(box.min.y).toBeCloseTo(0, 5);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 5);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 5);
  });

  it('las instancias comparten geometrías pero no materiales; dispose libera lo suyo', async () => {
    const m = await parseGlb(sampleGlb('sample-pump'));
    const a = createInstance(m);
    const meshes = (o: THREE.Object3D) => { const r: THREE.Mesh[] = []; o.traverse((x) => (x as THREE.Mesh).isMesh && r.push(x as THREE.Mesh)); return r; };
    const [ma] = meshes(a.object);
    const [mo] = meshes(m.scene);
    expect(ma!.geometry).toBe(mo!.geometry);
    expect(ma!.material).not.toBe(mo!.material);
    const matSpy = vi.spyOn(ma!.material as THREE.Material, 'dispose');
    const geoSpy = vi.spyOn(mo!.geometry, 'dispose');
    a.dispose();
    expect(matSpy).toHaveBeenCalled();
    expect(geoSpy).not.toHaveBeenCalled(); // la geometría es de la caché
    disposeModel(m);
    expect(geoSpy).toHaveBeenCalled();
  });
});
