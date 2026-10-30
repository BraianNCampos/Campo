import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Utilidades de test: fabrican GLB válidos e inválidos byte a byte (sin depender de ningún exportador). */

export const SAMPLES_DIR = resolve(__dirname, '../../../../examples/models');

/** Los GLB de ejemplo del repo (examples/models/*.glb). */
export function sampleGlbs(): { name: string; data: Buffer }[] {
  return readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith('.glb'))
    .sort()
    .map((name) => ({ name, data: readFileSync(join(SAMPLES_DIR, name)) }));
}

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RawGlbOptions {
  /** Sobrescribe la longitud de la cabecera (mentirosa). */
  headerLength?: number;
  version?: number;
  magic?: number;
  /** Tipo del primer bloque (def. JSON). */
  firstType?: number;
  /** Bloques adicionales tras el BIN: [tipo, datos]. */
  extraChunks?: [number, Buffer][];
  /** Bytes sueltos al final (tras el último bloque). */
  trailing?: Buffer;
  /** Relleno del JSON: 0x20 (def.) o 0x00. */
  padByte?: number;
  /** Sin alinear el JSON a 4 bytes. */
  noPad?: boolean;
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
};
const chunk = (type: number, body: Buffer): Buffer =>
  Buffer.concat([u32(body.length), u32(type), body]);

export const T_JSON = 0x4e4f534a;
export const T_BIN = 0x004e4942;

/** Ensambla un GLB. `json` puede ser un objeto, un string o bytes crudos (para JSON mal formado). */
export function glb(json: unknown, bin: Buffer | null = null, o: RawGlbOptions = {}): Buffer {
  let jsonBytes = Buffer.isBuffer(json)
    ? json
    : Buffer.from(typeof json === 'string' ? json : JSON.stringify(json), 'utf8');
  if (!o.noPad) {
    const pad = (4 - (jsonBytes.length % 4)) % 4;
    jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(pad, o.padByte ?? 0x20)]);
  }
  const parts = [chunk(o.firstType ?? T_JSON, jsonBytes)];
  if (bin) parts.push(chunk(T_BIN, bin));
  for (const [t, b] of o.extraChunks ?? []) parts.push(chunk(t, b));
  if (o.trailing) parts.push(o.trailing);
  const body = Buffer.concat(parts);
  const total = 12 + body.length;
  return Buffer.concat([
    u32(o.magic ?? 0x46546c67),
    u32(o.version ?? 2),
    u32(o.headerLength ?? total),
    body,
  ]);
}

/** Documento mínimo válido: un nodo con una malla de un triángulo (44 bytes de BIN). */
export function triangle(): { json: Json; bin: Buffer } {
  const bin = Buffer.alloc(44);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  [0, 1, 2].forEach((v, i) => bin.writeUInt16LE(v, 36 + i * 2));
  return {
    bin,
    json: {
      asset: { version: '2.0', generator: 'test' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'tri', mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 6 },
      ],
      buffers: [{ byteLength: 44 }],
    },
  };
}

/** GLB válido mínimo, con `mutate` opcional sobre el JSON antes de empaquetar. */
export function triangleGlb(
  mutate?: (json: Json) => void,
  o?: RawGlbOptions,
  binOverride?: Buffer | null,
): Buffer {
  const { json, bin } = triangle();
  mutate?.(json);
  return glb(json, binOverride === undefined ? bin : binOverride, o);
}

/**
 * GLB con una malla de `vertices` vértices (POSITION a ceros, sin índices): para probar el límite de vértices.
 * `meshes` crea esa cantidad de mallas, cada una con su propio accesor y un nodo que la referencia.
 */
export function bigMeshGlb(vertices: number, meshes = 1): Buffer {
  const per = vertices * 12;
  const bin = Buffer.alloc(per * meshes);
  const json: Json = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [] as number[] }],
    nodes: [] as Json[],
    meshes: [] as Json[],
    accessors: [] as Json[],
    bufferViews: [] as Json[],
    buffers: [{ byteLength: bin.length }],
  };
  for (let i = 0; i < meshes; i++) {
    json.bufferViews.push({ buffer: 0, byteOffset: i * per, byteLength: per });
    json.accessors.push({ bufferView: i, componentType: 5126, count: vertices, type: 'VEC3' });
    json.meshes.push({ primitives: [{ attributes: { POSITION: i } }] });
    json.nodes.push({ mesh: i });
    json.scenes[0].nodes.push(i);
  }
  return glb(json, bin);
}
