#!/usr/bin/env node
// Genera modelos glTF binarios (.glb) de ejemplo, sin dependencias, que siguen las convenciones de
// docs/architecture.md §10.2 (nodos `campo_level`, `campo_rotor`, `campo_gate`).
//
// Uso:  node scripts/make-sample-glb.mjs [directorio-de-salida]     (por defecto: examples/models)
// Como módulo: import { buildGlb, sampleModels } from './make-sample-glb.mjs'
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Caja con la base en y=0 (útil para animar `campo_level` escalando en Y desde el suelo). */
function box(w, h, d) {
  const x = w / 2, z = d / 2;
  const faces = [
    { n: [0, 1, 0], v: [[-x, h, -z], [-x, h, z], [x, h, z], [x, h, -z]] },
    { n: [0, -1, 0], v: [[-x, 0, z], [-x, 0, -z], [x, 0, -z], [x, 0, z]] },
    { n: [0, 0, 1], v: [[-x, 0, z], [x, 0, z], [x, h, z], [-x, h, z]] },
    { n: [0, 0, -1], v: [[x, 0, -z], [-x, 0, -z], [-x, h, -z], [x, h, -z]] },
    { n: [1, 0, 0], v: [[x, 0, z], [x, 0, -z], [x, h, -z], [x, h, z]] },
    { n: [-1, 0, 0], v: [[-x, 0, -z], [-x, 0, z], [-x, h, z], [-x, h, -z]] },
  ];
  const positions = [], normals = [], indices = [];
  faces.forEach((f, i) => {
    f.v.forEach((p) => { positions.push(...p); normals.push(...f.n); });
    const o = i * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices) };
}

/**
 * Construye un .glb a partir de una lista de nodos `{name, geometry:{w,h,d}, color:[r,g,b,a], translation?, rotation?}`.
 * Devuelve un Buffer listo para escribir en disco o subir a la API.
 */
export function buildGlb(nodes, { generator = 'campo-sample' } = {}) {
  const chunks = []; // { data: TypedArray, target }
  const bufferViews = [], accessors = [], meshes = [], materials = [], gltfNodes = [];
  let offset = 0;
  const pushView = (typed, target) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes, Buffer.alloc(pad));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    offset += bytes.length + pad;
    return bufferViews.length - 1;
  };
  for (const n of nodes) {
    const g = box(n.geometry.w, n.geometry.h, n.geometry.d);
    const pv = pushView(g.positions, 34962), nv = pushView(g.normals, 34962), iv = pushView(g.indices, 34963);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.positions.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], g.positions[i + k]); max[k] = Math.max(max[k], g.positions[i + k]);
    }
    const a0 = accessors.push({ bufferView: pv, componentType: 5126, count: g.positions.length / 3, type: 'VEC3', min, max }) - 1;
    const a1 = accessors.push({ bufferView: nv, componentType: 5126, count: g.normals.length / 3, type: 'VEC3' }) - 1;
    const a2 = accessors.push({ bufferView: iv, componentType: 5123, count: g.indices.length, type: 'SCALAR' }) - 1;
    const m = materials.push({ name: `${n.name}_mat`, pbrMetallicRoughness: { baseColorFactor: n.color ?? [0.7, 0.7, 0.75, 1], metallicFactor: 0.2, roughnessFactor: 0.6 } }) - 1;
    const mesh = meshes.push({ name: `${n.name}_mesh`, primitives: [{ attributes: { POSITION: a0, NORMAL: a1 }, indices: a2, material: m }] }) - 1;
    const node = { name: n.name, mesh };
    if (n.translation) node.translation = n.translation;
    if (n.rotation) node.rotation = n.rotation;
    gltfNodes.push(node);
  }
  const json = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: gltfNodes.map((_, i) => i) }],
    nodes: gltfNodes, meshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBytes.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBytes, bh, bin]);
}

/** Modelos de ejemplo: cada uno con los nodos de animación que usa la web (ver §10.2). */
export function sampleModels() {
  return {
    'sample-tank.glb': buildGlb([
      { name: 'shell', geometry: { w: 2, h: 3, d: 2 }, color: [0.55, 0.58, 0.62, 1] },
      { name: 'campo_level', geometry: { w: 1.8, h: 1, d: 1.8 }, color: [0.2, 0.6, 0.9, 1], translation: [0, 0.1, 0] },
    ]),
    'sample-pump.glb': buildGlb([
      { name: 'housing', geometry: { w: 1.4, h: 1, d: 1 }, color: [0.3, 0.35, 0.45, 1] },
      { name: 'campo_rotor', geometry: { w: 0.8, h: 0.2, d: 0.2 }, color: [0.95, 0.75, 0.2, 1], translation: [0, 1.05, 0] },
    ]),
    'sample-valve.glb': buildGlb([
      { name: 'body', geometry: { w: 0.8, h: 0.8, d: 0.8 }, color: [0.4, 0.4, 0.45, 1] },
      { name: 'campo_gate', geometry: { w: 0.15, h: 0.9, d: 0.5 }, color: [0.9, 0.3, 0.2, 1], translation: [0, 0.85, 0] },
    ]),
    'sample-static.glb': buildGlb([
      { name: 'block', geometry: { w: 1.5, h: 1.5, d: 1.5 }, color: [0.6, 0.45, 0.3, 1] },
    ]),
  };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = resolve(process.argv[2] ?? join(root, 'examples', 'models'));
  mkdirSync(out, { recursive: true });
  for (const [name, buf] of Object.entries(sampleModels())) {
    writeFileSync(join(out, name), buf);
    console.log(`${join(out, name)}  ${buf.length} bytes`);
  }
}
